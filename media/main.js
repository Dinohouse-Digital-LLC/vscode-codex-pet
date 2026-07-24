(function () {
  const vscodeApi = acquireVsCodeApi();
  const canvas = document.getElementById('pet-canvas');
  const ctx = canvas.getContext('2d');
  const stage = document.getElementById('pet-stage');

  /** @type {{ id: string, spriteUri: string, configUri: string, standardConfigUri: string }[]} */
  const petDefs = window.CODEX_PET.pets || [];

  const timing = Object.assign(
    {
      walkSpeed: 40,
      moveChance: 0.5,
      minActionDuration: 3000,
      maxActionDuration: 10000,
      jumpCooldown: 5000,
      idleAnimationSpeed: 0.5,
    },
    window.CODEX_PET.timing || {},
  );

  let aiBusy = false;
  let aiLabel = '';
  let waitingSessions = [];
  let streakInfo = null;
  let hoveringStreakBadge = false;
  let streakBadgeBox = null;
  let userScale = Number(window.CODEX_PET.scale) || 1;
  let idleStateWeights = window.CODEX_PET.idleStateWeights || {};

  let petGrowth = Object.assign(
    { enabled: false, minScale: 0.7, maxScale: 1.5, maxLevel: 20 },
    window.CODEX_PET.petGrowth || {},
  );

  const LEVEL_UP_FLASH_DURATION = 1500;
  const REACTION_DURATION = 1200;
  const JUMP_BASE_HEIGHT = 30;
  const CHASE_SPACING_GAP = 12;

  let nearestPetToCursor = null;
  let cursorX = null;
  let cursorY = null;
  let cursorActive = false;

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function pickWeighted(states) {
    const weighted = states.map((s) => ({ s, w: Math.max(0, idleStateWeights[s] ?? 1) }));
    const total = weighted.reduce((sum, { w }) => sum + w, 0);
    if (total <= 0) return states[Math.floor(Math.random() * states.length)];
    let r = Math.random() * total;
    for (const { s, w } of weighted) {
      if (r < w) return s;
      r -= w;
    }
    return weighted[weighted.length - 1].s;
  }

  function roundRectPath(x0, y0, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0);
    ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
    ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
    ctx.arcTo(x0, y0 + h, x0, y0, r);
    ctx.arcTo(x0, y0, x0 + w, y0, r);
    ctx.closePath();
  }

  function createPetInstance(def) {
    return {
      id: def.id,
      spriteUri: def.spriteUri,
      configUri: def.configUri,

      config: null,
      spriteImage: null,
      spriteLoaded: false,

      currentState: 'idle',
      frameIndex: 0,
      frameTimer: 0,

      x: 40,
      facing: 1, // 1 = right, -1 = left
      moving: false,
      stateTimer: 0,
      stateDuration: randomBetween(timing.minActionDuration, timing.maxActionDuration),

      petBox: { x: 0, y: 0, w: 0, h: 0 },
      hearts: [],
      reacting: false,
      jumpCooldown: 0,
      jumpHeight: 0,
      jumpFrameDuration: null,
      wasAiBusy: false,

      level: null,
      xpProgress: 0,
      levelUpFlash: 0,
      hoveringLevelBadge: false,
      levelBadgeBox: null,
      hoveringWaitingBadge: false,
      waitingBadgeBox: null,
    };
  }

  const pets = petDefs.map((def) => createPetInstance(def));

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;

    if (data.type === 'update-timing') {
      Object.assign(timing, data.timing);
    }
    if (data.type === 'ai-state') {
      aiBusy = Boolean(data.busy);
      aiLabel = data.label || '';
      waitingSessions = Array.isArray(data.waiting) ? data.waiting : [];
    }
    if (data.type === 'update-scale') {
      userScale = Number(data.scale) || 1;
    }
    if (data.type === 'update-idle-weights') {
      idleStateWeights = data.weights || {};
    }
    if (data.type === 'xp-update') {
      for (const entry of data.pets || []) {
        const pet = pets.find((p) => p.id === entry.petId);
        if (!pet) continue;
        pet.level = entry.level;
        pet.xpProgress = Number(entry.progress) || 0;
        if (entry.leveledUp) celebrateLevelUp(pet);
      }
    }
    if (data.type === 'update-pet-growth') {
      petGrowth = Object.assign({}, petGrowth, data.growth);
    }
    if (data.type === 'streak-update') {
      streakInfo = data.streak || null;
    }
  });

  function celebrateLevelUp(pet) {
    pet.levelUpFlash = LEVEL_UP_FLASH_DURATION;
    if (pet.config?.states?.jump) {
      activateJump(pet, pet.petBox.y - JUMP_BASE_HEIGHT * 1.5);
    }
    spawnHeart(pet, pet.petBox.x + pet.petBox.w / 2, pet.petBox.y);
    spawnHeart(pet, pet.petBox.x + pet.petBox.w / 2, pet.petBox.y);
  }

  function getGrowthMultiplier(pet) {
    if (!petGrowth.enabled || pet.level === null) return 1;
    const maxLevel = Math.max(petGrowth.maxLevel, 2);
    const t = clamp((pet.level - 1) / (maxLevel - 1), 0, 1);
    return petGrowth.minScale + t * (petGrowth.maxScale - petGrowth.minScale);
  }

  // Prestige: past petGrowthMaxLevel, size growth plateaus but there's still
  // a visible payoff for leveling further — a golden badge border + a slow
  // sparkle aura around the pet.
  function isPrestige(pet) {
    return petGrowth.enabled && pet.level !== null && pet.level >= petGrowth.maxLevel;
  }

  function drawPrestigeAura(pet, now) {
    if (!isPrestige(pet)) return;

    const cx = pet.petBox.x + pet.petBox.w / 2;
    const cy = pet.petBox.y + pet.petBox.h / 2;
    const radiusX = pet.petBox.w / 2 + 8;
    const radiusY = pet.petBox.h / 2 + 4;
    const sparkleCount = 4;

    ctx.save();
    for (let i = 0; i < sparkleCount; i++) {
      const angle = now / 900 + (i * (Math.PI * 2)) / sparkleCount;
      const sx = cx + Math.cos(angle) * radiusX;
      const sy = cy + Math.sin(angle) * radiusY;
      const twinkle = 0.5 + 0.5 * Math.sin(now / 220 + i * 1.7);
      ctx.globalAlpha = 0.35 + twinkle * 0.5;
      ctx.fillStyle = '#ffd558';
      ctx.beginPath();
      ctx.arc(sx, sy, 1.4 + twinkle * 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // How much of the stage a single sprite is allowed to fill. Sprites stand on
  // the bottom edge and jump upward, so leaving headroom keeps a big pet from
  // clipping through the top of the container (the "glitching" you see when a
  // sprite is scaled larger than the panel it lives in).
  const MAX_SPRITE_HEIGHT_FRACTION = 0.85;
  const MAX_SPRITE_WIDTH_FRACTION = 0.9;

  // Caps the requested scale so the drawn sprite never outgrows the container.
  // Only ever shrinks (returns <= 1), so the user's scale preference is honored
  // whenever there's room and we adapt down automatically on small panels.
  function containerFit(pet, baseScale) {
    if (!canvas.height || !canvas.width) return 1;
    const frameWidth = pet.config.frameWidth || 40;
    const frameHeight = pet.config.frameHeight || 40;
    const maxByHeight = (canvas.height * MAX_SPRITE_HEIGHT_FRACTION) / (frameHeight * baseScale);
    const maxByWidth = (canvas.width * MAX_SPRITE_WIDTH_FRACTION) / (frameWidth * baseScale);
    return clamp(Math.min(1, maxByHeight, maxByWidth), 0, 1);
  }

  function getScale(pet) {
    const base = (pet.config.scale || 1) * userScale * getGrowthMultiplier(pet);
    return base * containerFit(pet, base);
  }

  function resizeCanvas() {
    canvas.width = stage.clientWidth;
    canvas.height = stage.clientHeight;
  }
  window.addEventListener('resize', resizeCanvas);

  function initialXFor(index, total) {
    if (total <= 1) return 40;
    const margin = 40;
    const usable = Math.max(0, canvas.width - margin * 2);
    return margin + (usable * index) / (total - 1);
  }

  // Nonstandard-seamless manifests use a richer per-action schema (baked
  // ping-pong loops with an explicit frame list), but every pet's frame
  // columns run sequentially from 0, so it reduces to the same
  // row/frameCount/fps/loop shape the renderer already knows how to play.
  //
  // The `look-*` actions are deliberately absent from this map: they are
  // direction poses (two rows of 8 sources, 22.5 degrees apart, covering a
  // full turn), not animations, so playing them in the idle rotation would
  // read as the pet spinning. Leaving them unmapped keeps them out of
  // `states` entirely. They are reserved for aiming the pet at the cursor
  // later, which needs a pose lookup rather than a state.
  const SEAMLESS_STATE_IDS = {
    idle: 'idle',
    'running-right': 'runRight',
    'running-left': 'runLeft',
    waving: 'wave',
    jumping: 'jump',
    failed: 'failed',
    waiting: 'waiting',
    running: 'run',
    review: 'review',
  };

  // Each manifest declares its own cell size (`frameWidth`/`frameHeight` for
  // the standard schema, `cell.width`/`cell.height` for seamless ones), and
  // those sizes aren't guaranteed to match between a pet's standard sheet
  // and its alternate one. `scale` is derived, not copied, so an alternate
  // sheet renders at the same on-screen footprint as the standard manifest
  // regardless of its own cell resolution.
  const referenceFrameSizeCache = new Map();
  async function loadReferenceFrameSize(pet) {
    if (!pet.standardConfigUri) return { frameWidth: 192, frameHeight: 208, scale: 1 };
    if (referenceFrameSizeCache.has(pet.standardConfigUri)) {
      return referenceFrameSizeCache.get(pet.standardConfigUri);
    }
    const res = await fetch(pet.standardConfigUri);
    const standard = await res.json();
    const ref = {
      frameWidth: standard.frameWidth,
      frameHeight: standard.frameHeight,
      scale: standard.scale || 1,
    };
    referenceFrameSizeCache.set(pet.standardConfigUri, ref);
    return ref;
  }

  function normalizeSeamlessConfig(raw, ref) {
    const states = {};
    for (const action of raw.actions || []) {
      const stateId = SEAMLESS_STATE_IDS[action.id];
      if (!stateId) continue;
      states[stateId] = {
        row: action.rowIndex,
        frameCount: action.frameCount,
        fps: action.fps,
        loop: action.loop,
      };
    }
    return {
      frameWidth: raw.cell.width,
      frameHeight: raw.cell.height,
      scale: (ref.frameWidth * ref.scale) / raw.cell.width,
      defaultState: 'idle',
      busyState: 'review',
      movementStates: { right: 'runRight', left: 'runLeft' },
      idleStates: ['idle', 'wave', 'jump', 'waiting', 'review', 'failed'],
      reactionStates: ['wave', 'jump'],
      states,
    };
  }

  async function loadConfig(pet) {
    const res = await fetch(pet.configUri);
    const raw = await res.json();
    if (Array.isArray(raw.actions)) {
      const ref = await loadReferenceFrameSize(pet);
      pet.config = normalizeSeamlessConfig(raw, ref);
    } else {
      pet.config = raw;
    }
    pet.currentState = pet.config.defaultState || 'idle';
  }

  function loadSprite(pet) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        pet.spriteImage = img;
        pet.spriteLoaded = true;
        resolve();
      };
      img.onerror = () => {
        pet.spriteLoaded = false;
        resolve();
      };
      img.src = pet.spriteUri;
    });
  }

  function pickNextAction(pet) {
    pet.moving = Math.random() < timing.moveChance;

    if (pet.moving) {
      pet.facing = Math.random() < 0.5 ? 1 : -1;
      pet.currentState =
        pet.facing === 1 ? pet.config.movementStates.right : pet.config.movementStates.left;
    } else {
      pet.currentState = pickWeighted(pet.config.idleStates);
    }
    pet.stateDuration = randomBetween(timing.minActionDuration, timing.maxActionDuration);

    pet.frameIndex = 0;
    pet.frameTimer = 0;
    pet.stateTimer = 0;
  }

  function activateReaction(pet, stateName, duration) {
    const state = pet.config.states[stateName];
    if (!state) return;

    pet.currentState = stateName;
    pet.moving = false;
    pet.frameIndex = 0;
    pet.frameTimer = 0;
    pet.stateTimer = 0;
    pet.reacting = true;
    pet.stateDuration = duration ?? (state.loop ? REACTION_DURATION : (state.frameCount / state.fps) * 1000);
  }

  function activateJump(pet, targetHeight) {
    const state = pet.config.states.jump;
    if (!state) return;

    const naturalDuration = (state.frameCount / state.fps) * 1000;
    // Jumps are capped by the top of the window the pet is in, not a fixed height.
    const maxHeight = Math.max(JUMP_BASE_HEIGHT, pet.petBox.y - 4);
    const height = clamp(targetHeight, JUMP_BASE_HEIGHT, maxHeight);
    // Taller jumps play out slower so the sprite has time to actually reach the apex.
    const durationScale = clamp(height / JUMP_BASE_HEIGHT, 1, maxHeight / JUMP_BASE_HEIGHT);
    const duration = naturalDuration * durationScale;

    pet.currentState = 'jump';
    pet.moving = false;
    pet.frameIndex = 0;
    pet.frameTimer = 0;
    pet.stateTimer = 0;
    pet.reacting = true;
    pet.stateDuration = duration;
    pet.jumpHeight = height;
    pet.jumpFrameDuration = duration / state.frameCount;
  }

  function getVerticalOffset(pet) {
    if (pet.currentState !== 'jump' || !pet.reacting || !pet.jumpHeight) return 0;
    const progress = clamp(pet.stateTimer / pet.stateDuration, 0, 1);
    return Math.sin(progress * Math.PI) * pet.jumpHeight;
  }

  function triggerReaction(pet) {
    if (!pet.config) return;
    const candidates = (pet.config.reactionStates || []).filter((s) => pet.config.states[s]);
    if (candidates.length === 0) return;
    const choice = candidates[Math.floor(Math.random() * candidates.length)];
    if (choice === 'jump') {
      activateJump(pet, JUMP_BASE_HEIGHT);
    } else {
      activateReaction(pet, choice, REACTION_DURATION);
    }
  }

  // All pets chase the cursor, but queue up beside it rather than stacking:
  // pet i of n targets cursorX offset by its position in the line, spaced by
  // its own scaled sprite width so it holds up across different petScale values.
  function chaseCursor(pet, dt) {
    const spriteWidth = (pet.config.frameWidth || 40) * getScale(pet);
    const n = pets.length;
    // Rank by current x, not array order: pets wander independently during
    // idle behavior, so their left-to-right order on screen can drift away
    // from petDefs order. Slotting by live position keeps each pet's queue
    // spot matching where it's actually standing while it walks over to wait
    // beside the cursor.
    const i = [...pets].sort((a, b) => a.x - b.x).indexOf(pet);
    const spacing = spriteWidth + CHASE_SPACING_GAP;
    const targetCursorX = cursorX + (i - (n - 1) / 2) * spacing;

    const spriteCenter = pet.x + spriteWidth / 2;
    const alignThreshold = spriteWidth / 3;
    const isAbove = cursorY !== null && cursorY < pet.petBox.y - 10;
    // The greeting jump is about the cursor being over THIS pet, not about
    // reaching its queue slot (which sits offset to the side of the cursor
    // so pets don't stack). Checking proximity to cursorX directly, and
    // requiring this pet be the closest of the bunch, keeps the jump on
    // whichever pet the mouse is actually near instead of whichever one
    // happens to walk into a side slot first.
    const isNearCursor = Math.abs(cursorX - spriteCenter) <= alignThreshold;

    if (
      isNearCursor &&
      pet === nearestPetToCursor &&
      isAbove &&
      pet.jumpCooldown <= 0 &&
      pet.config.states.jump
    ) {
      activateJump(pet, pet.petBox.y - cursorY);
      pet.jumpCooldown = timing.jumpCooldown;
      return;
    }

    const targetX = clamp(targetCursorX - spriteWidth / 2, 0, canvas.width - spriteWidth);
    const dx = targetX - pet.x;
    const moveThreshold = 3;

    if (Math.abs(dx) <= moveThreshold) {
      if (pet.moving) {
        pet.moving = false;
        pet.currentState = pet.config.defaultState || 'idle';
        pet.frameIndex = 0;
        pet.frameTimer = 0;
      }
      return;
    }

    pet.moving = true;
    const newFacing = dx > 0 ? 1 : -1;
    const desiredState =
      newFacing === 1 ? pet.config.movementStates.right : pet.config.movementStates.left;
    if (desiredState !== pet.currentState) {
      pet.facing = newFacing;
      pet.currentState = desiredState;
      pet.frameIndex = 0;
      pet.frameTimer = 0;
    }

    const step = Math.min((timing.walkSpeed * dt) / 1000, Math.abs(dx));
    pet.x += Math.sign(dx) * step;
    pet.x = clamp(pet.x, 0, canvas.width - spriteWidth);
  }

  function drawAiBubble(pet, now) {
    if (!aiBusy) return;

    const dotCount = 1 + Math.floor((now / 400) % 3);
    const text = aiLabel ? `${aiLabel} ${'.'.repeat(dotCount)}` : '.'.repeat(dotCount);

    const bubbleHeight = 20;
    const cx = pet.petBox.x + pet.petBox.w / 2;
    const bottomY = pet.petBox.y - 6;
    const topY = bottomY - bubbleHeight;

    ctx.save();
    ctx.font = 'bold 11px sans-serif';
    const textWidth = ctx.measureText(text).width;
    const bubbleWidth = clamp(textWidth + 16, 34, canvas.width - 4);
    const left = clamp(cx - bubbleWidth / 2, 2, canvas.width - bubbleWidth - 2);

    ctx.fillStyle = 'rgba(20, 20, 20, 0.85)';
    roundRectPath(left, topY, bubbleWidth, bubbleHeight, 6);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx - 5, bottomY - 1);
    ctx.lineTo(cx + 5, bottomY - 1);
    ctx.lineTo(cx, bottomY + 6);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#f0f0f0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + bubbleWidth / 2, topY + bubbleHeight / 2 - 1);
    ctx.restore();
  }

  function drawWaitingBadge(pet) {
    if (waitingSessions.length === 0) {
      pet.waitingBadgeBox = null;
      return;
    }

    const radius = 9;
    const cx = pet.petBox.x + radius + 2;
    const cy = pet.petBox.y + radius + 2;
    pet.waitingBadgeBox = { x: cx - radius, y: cy - radius, w: radius * 2, h: radius * 2 };

    ctx.save();
    ctx.fillStyle = 'rgba(220, 70, 60, 0.95)';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(waitingSessions.length), cx, cy + 1);
    ctx.restore();
  }

  function drawWaitingTooltip(pet) {
    if (!pet.hoveringWaitingBadge || waitingSessions.length === 0 || !pet.waitingBadgeBox) return;

    const text = waitingSessions.map((s) => s.label).join(', ');
    const bubbleHeight = 20;
    const cx = pet.waitingBadgeBox.x + pet.waitingBadgeBox.w / 2;
    const bottomY = pet.waitingBadgeBox.y - 4;
    const topY = bottomY - bubbleHeight;

    ctx.save();
    ctx.font = 'bold 11px sans-serif';
    const textWidth = ctx.measureText(text).width;
    const bubbleWidth = clamp(textWidth + 16, 34, canvas.width - 4);
    const left = clamp(cx - bubbleWidth / 2, 2, canvas.width - bubbleWidth - 2);

    ctx.fillStyle = 'rgba(20, 20, 20, 0.85)';
    roundRectPath(left, topY, bubbleWidth, bubbleHeight, 6);
    ctx.fill();

    ctx.fillStyle = '#f0f0f0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + bubbleWidth / 2, topY + bubbleHeight / 2 - 1);
    ctx.restore();
  }

  // Streak/multiplier badge: global (not per-pet) state, so it's drawn once
  // per frame anchored to the canvas corner rather than a pet's box.
  function drawStreakBadge() {
    if (!streakInfo) {
      streakBadgeBox = null;
      return;
    }

    const text = `🔥${streakInfo.dailyStreakDays}d  ${streakInfo.multiplier.toFixed(2)}x`;
    const badgeHeight = 16;

    ctx.save();
    ctx.font = 'bold 10px sans-serif';
    const textWidth = ctx.measureText(text).width;
    const badgeWidth = textWidth + 14;

    const left = canvas.width - badgeWidth - 4;
    const top = 4;
    streakBadgeBox = { x: left, y: top, w: badgeWidth, h: badgeHeight };

    ctx.fillStyle =
      streakInfo.multiplier > 1 ? 'rgba(220, 120, 40, 0.85)' : 'rgba(20, 20, 20, 0.75)';
    roundRectPath(left, top, badgeWidth, badgeHeight, 5);
    ctx.fill();

    ctx.fillStyle = '#f5f5f5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + badgeWidth / 2, top + badgeHeight / 2 + 1);
    ctx.restore();
  }

  function drawStreakTooltip() {
    if (!hoveringStreakBadge || !streakInfo || !streakBadgeBox) return;

    const sessionMinutes = Math.floor(streakInfo.sessionActiveMs / 60000);
    const bonuses = streakInfo.bonuses || {};
    const lines = [
      `Daily streak: ${streakInfo.dailyStreakDays}d (+${Math.round((bonuses.daily || 0) * 100)}%)`,
      `Session: ${sessionMinutes}m (+${Math.round((bonuses.session || 0) * 100)}%)`,
    ];
    if (bonuses.weekend > 0) lines.push(`Weekend bonus: +${Math.round(bonuses.weekend * 100)}%`);
    if (bonuses.lateNight > 0) lines.push(`Late night bonus: +${Math.round(bonuses.lateNight * 100)}%`);

    const lineHeight = 14;
    const padding = 6;
    const bubbleHeight = lines.length * lineHeight + padding * 2;

    ctx.save();
    ctx.font = '11px sans-serif';
    const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const bubbleWidth = textWidth + padding * 2;
    const right = streakBadgeBox.x + streakBadgeBox.w;
    const bottomY = streakBadgeBox.y + streakBadgeBox.h + 4;
    const left = clamp(right - bubbleWidth, 2, canvas.width - bubbleWidth - 2);

    ctx.fillStyle = 'rgba(20, 20, 20, 0.9)';
    roundRectPath(left, bottomY, bubbleWidth, bubbleHeight, 6);
    ctx.fill();

    ctx.fillStyle = '#f0f0f0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((line, i) => {
      ctx.fillText(line, left + padding, bottomY + padding + lineHeight * i + lineHeight / 2);
    });
    ctx.restore();
  }

  function drawLevelBadge(pet) {
    if (pet.level === null) {
      pet.levelBadgeBox = null;
      return;
    }

    const flashing = pet.levelUpFlash > 0;
    const text = `Lvl ${pet.level}`;
    const badgeHeight = 16;
    const barHeight = 3;
    const totalHeight = badgeHeight + barHeight;

    ctx.save();
    ctx.font = 'bold 10px sans-serif';
    const textWidth = ctx.measureText(text).width;
    const badgeWidth = textWidth + 14;

    const right = pet.petBox.x + pet.petBox.w - 2;
    const top = pet.petBox.y + 2;
    const left = right - badgeWidth;
    pet.levelBadgeBox = { x: left, y: top, w: badgeWidth, h: totalHeight };

    ctx.fillStyle = flashing ? 'rgba(255, 205, 60, 0.95)' : 'rgba(20, 20, 20, 0.75)';
    roundRectPath(left, top, badgeWidth, badgeHeight, 5);
    ctx.fill();

    if (isPrestige(pet) && !flashing) {
      ctx.strokeStyle = 'rgba(255, 213, 88, 0.9)';
      ctx.lineWidth = 1.5;
      roundRectPath(left, top, badgeWidth, badgeHeight, 5);
      ctx.stroke();
    }

    ctx.fillStyle = flashing ? '#3a2a00' : '#f0f0f0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + badgeWidth / 2, top + badgeHeight / 2);

    // Progress-to-next-level bar underneath the badge.
    const barY = top + badgeHeight + 1;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    roundRectPath(left, barY, badgeWidth, barHeight, 1.5);
    ctx.fill();
    if (pet.xpProgress > 0) {
      ctx.fillStyle = flashing ? 'rgba(255, 205, 60, 0.95)' : 'rgba(140, 210, 255, 0.95)';
      roundRectPath(left, barY, badgeWidth * pet.xpProgress, barHeight, 1.5);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawLevelTooltip(pet) {
    if (!pet.hoveringLevelBadge || pet.level === null || !pet.levelBadgeBox) return;

    const text = `Level ${pet.level} — ${Math.round(pet.xpProgress * 100)}% to next`;
    const bubbleHeight = 20;
    const cx = pet.levelBadgeBox.x + pet.levelBadgeBox.w / 2;
    const bottomY = pet.levelBadgeBox.y - 4;
    const topY = bottomY - bubbleHeight;

    ctx.save();
    ctx.font = 'bold 11px sans-serif';
    const textWidth = ctx.measureText(text).width;
    const bubbleWidth = clamp(textWidth + 16, 34, canvas.width - 4);
    const left = clamp(cx - bubbleWidth / 2, 2, canvas.width - bubbleWidth - 2);

    ctx.fillStyle = 'rgba(20, 20, 20, 0.85)';
    roundRectPath(left, topY, bubbleWidth, bubbleHeight, 6);
    ctx.fill();

    ctx.fillStyle = '#f0f0f0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + bubbleWidth / 2, topY + bubbleHeight / 2 - 1);
    ctx.restore();
  }

  function spawnHeart(pet, cx, topY) {
    pet.hearts.push({ x: cx + (Math.random() * 20 - 10), y: topY, life: 0, duration: 900 });
  }

  function updateHearts(pet, dt) {
    for (const heart of pet.hearts) heart.life += dt;
    pet.hearts = pet.hearts.filter((heart) => heart.life < heart.duration);
  }

  function drawHearts(pet) {
    if (pet.hearts.length === 0) return;
    ctx.save();
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    for (const heart of pet.hearts) {
      const t = heart.life / heart.duration;
      ctx.globalAlpha = 1 - t;
      ctx.fillText('❤', heart.x, heart.y - t * 24);
    }
    ctx.restore();
  }

  function petAtPoint(cx, cy) {
    // Reverse draw order so a pet drawn on top of another is hit first.
    for (let i = pets.length - 1; i >= 0; i--) {
      const pet = pets[i];
      const box = pet.petBox;
      if (cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h) return pet;
    }
    return null;
  }

  canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    const pet = petAtPoint(cx, cy);
    if (!pet) return;

    triggerReaction(pet);
    spawnHeart(pet, pet.petBox.x + pet.petBox.w / 2, pet.petBox.y);
    vscodeApi.postMessage({ type: 'pet-click', petId: pet.id });
  });

  canvas.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;

    canvas.style.cursor = petAtPoint(cx, cy) ? 'pointer' : 'default';

    for (const pet of pets) {
      pet.hoveringWaitingBadge = Boolean(
        pet.waitingBadgeBox &&
          cx >= pet.waitingBadgeBox.x &&
          cx <= pet.waitingBadgeBox.x + pet.waitingBadgeBox.w &&
          cy >= pet.waitingBadgeBox.y &&
          cy <= pet.waitingBadgeBox.y + pet.waitingBadgeBox.h,
      );

      pet.hoveringLevelBadge = Boolean(
        pet.levelBadgeBox &&
          cx >= pet.levelBadgeBox.x &&
          cx <= pet.levelBadgeBox.x + pet.levelBadgeBox.w &&
          cy >= pet.levelBadgeBox.y &&
          cy <= pet.levelBadgeBox.y + pet.levelBadgeBox.h,
      );
    }

    hoveringStreakBadge = Boolean(
      streakBadgeBox &&
        cx >= streakBadgeBox.x &&
        cx <= streakBadgeBox.x + streakBadgeBox.w &&
        cy >= streakBadgeBox.y &&
        cy <= streakBadgeBox.y + streakBadgeBox.h,
    );

    cursorX = cx;
    cursorY = cy;
    cursorActive = true;
  });

  canvas.addEventListener('mouseleave', () => {
    cursorActive = false;
    cursorX = null;
    cursorY = null;
    for (const pet of pets) {
      pet.hoveringWaitingBadge = false;
      pet.hoveringLevelBadge = false;
    }
    hoveringStreakBadge = false;
  });

  function drawPlaceholder(pet, scale) {
    const w = 40 * scale;
    const h = 40 * scale;
    const groundY = canvas.height - h - getVerticalOffset(pet);
    pet.petBox = { x: pet.x, y: groundY, w, h };
    ctx.save();
    ctx.translate(pet.x, groundY);
    if (pet.facing < 0) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.fillStyle = pet.moving ? '#e0a13c' : '#c98a2e';
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#00000055';
    ctx.beginPath();
    ctx.arc(w * 0.32, h * 0.4, w * 0.06, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSprite(pet, dt) {
    const state = pet.config.states[pet.currentState];
    if (!state) return;

    pet.frameTimer += dt;
    const isIdleState = (pet.config.idleStates || []).includes(pet.currentState);
    const speedMultiplier = isIdleState ? timing.idleAnimationSpeed || 1 : 1;
    const frameDuration =
      pet.currentState === 'jump' && pet.reacting && pet.jumpFrameDuration
        ? pet.jumpFrameDuration
        : 1000 / state.fps / speedMultiplier;
    if (pet.frameTimer >= frameDuration) {
      pet.frameTimer = 0;
      pet.frameIndex += 1;
      if (pet.frameIndex >= state.frameCount) {
        pet.frameIndex = state.loop ? 0 : state.frameCount - 1;
      }
    }

    if (!pet.spriteLoaded) {
      drawPlaceholder(pet, getScale(pet));
      return;
    }

    const { frameWidth, frameHeight } = pet.config;
    const scale = getScale(pet);
    const sx = pet.frameIndex * frameWidth;
    const sy = state.row * frameHeight;
    const dw = frameWidth * scale;
    const dh = frameHeight * scale;
    const groundY = canvas.height - dh - getVerticalOffset(pet);
    pet.petBox = { x: pet.x, y: groundY, w: dw, h: dh };

    ctx.drawImage(pet.spriteImage, sx, sy, frameWidth, frameHeight, pet.x, groundY, dw, dh);
  }

  function updatePet(pet, dt, now) {
    if (pet.jumpCooldown > 0) pet.jumpCooldown -= dt;
    if (pet.levelUpFlash > 0) pet.levelUpFlash -= dt;

    if (pet.reacting) {
      pet.stateTimer += dt;
      if (pet.stateTimer >= pet.stateDuration) {
        pet.reacting = false;
      }
    } else if (cursorActive) {
      pet.wasAiBusy = false;
      chaseCursor(pet, dt);
    } else if (aiBusy && pet.config.states[pet.config.busyState]) {
      if (!pet.wasAiBusy) {
        pet.currentState = pet.config.busyState;
        pet.moving = false;
        pet.frameIndex = 0;
        pet.frameTimer = 0;
        pet.wasAiBusy = true;
      }
    } else {
      if (pet.wasAiBusy) {
        pet.wasAiBusy = false;
        pickNextAction(pet);
      }
      pet.stateTimer += dt;
      if (pet.stateTimer >= pet.stateDuration) {
        pickNextAction(pet);
      }

      if (pet.moving) {
        pet.x += (pet.facing * timing.walkSpeed * dt) / 1000;
        const spriteWidth = (pet.config.frameWidth || 40) * getScale(pet);
        if (pet.x <= 0) {
          pet.x = 0;
          pet.facing = 1;
          pet.currentState = pet.config.movementStates.right;
        } else if (pet.x + spriteWidth >= canvas.width) {
          pet.x = canvas.width - spriteWidth;
          pet.facing = -1;
          pet.currentState = pet.config.movementStates.left;
        }
      }
    }

    drawSprite(pet, dt);
    drawPrestigeAura(pet, now);
    drawAiBubble(pet, now);
    drawLevelBadge(pet);
    drawLevelTooltip(pet);
    drawWaitingBadge(pet);
    drawWaitingTooltip(pet);
    updateHearts(pet, dt);
    drawHearts(pet);
  }

  let lastTime = performance.now();

  function tick(now) {
    const dt = now - lastTime;
    lastTime = now;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Recomputed once per frame (not per-pet inside chaseCursor) so every
    // pet checks against the same snapshot of "who's actually closest" —
    // otherwise ties/near-ties could let more than one pet think it's the
    // nearest and both jump, or neither would agree on who should.
    nearestPetToCursor = null;
    if (cursorActive && cursorX !== null) {
      let bestDist = Infinity;
      for (const pet of pets) {
        if (!pet.config) continue;
        const spriteWidth = (pet.config.frameWidth || 40) * getScale(pet);
        const dist = Math.abs(cursorX - (pet.x + spriteWidth / 2));
        if (dist < bestDist) {
          bestDist = dist;
          nearestPetToCursor = pet;
        }
      }
    }

    // Draw order = array order, so later entries render on top.
    for (const pet of pets) {
      if (!pet.config) continue;
      updatePet(pet, dt, now);
    }

    drawStreakBadge();
    drawStreakTooltip();

    requestAnimationFrame(tick);
  }

  (async function init() {
    resizeCanvas();
    pets.forEach((pet, i) => {
      pet.x = initialXFor(i, pets.length);
    });
    await Promise.all(
      pets.map(async (pet) => {
        await loadConfig(pet);
        await loadSprite(pet);
      }),
    );
    requestAnimationFrame(tick);
  })();
})();
