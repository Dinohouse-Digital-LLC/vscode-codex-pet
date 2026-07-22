(function () {
  const canvas = document.getElementById('pet-canvas');
  const ctx = canvas.getContext('2d');
  const stage = document.getElementById('pet-stage');

  /** @type {{ spriteUri: string, configUri: string, timing: object }} */
  const { spriteUri, configUri } = window.CODEX_PET;

  const timing = Object.assign(
    { walkSpeed: 40, moveChance: 0.5, minActionDuration: 1500, maxActionDuration: 3500, jumpCooldown: 5000 },
    window.CODEX_PET.timing || {},
  );

  let aiBusy = false;
  let wasAiBusy = false;
  let userScale = Number(window.CODEX_PET.scale) || 1;
  let idleStateWeights = window.CODEX_PET.idleStateWeights || {};

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'update-timing') {
      Object.assign(timing, event.data.timing);
    }
    if (event.data?.type === 'ai-state') {
      aiBusy = Boolean(event.data.busy);
    }
    if (event.data?.type === 'update-scale') {
      userScale = Number(event.data.scale) || 1;
    }
    if (event.data?.type === 'update-idle-weights') {
      idleStateWeights = event.data.weights || {};
    }
  });

  let config = null;
  let spriteImage = null;
  let spriteLoaded = false;

  let currentState = 'idle';
  let frameIndex = 0;
  let frameTimer = 0;

  let x = 40;
  let facing = 1; // 1 = right, -1 = left
  let moving = false;
  let stateTimer = 0;
  let stateDuration = randomBetween(timing.minActionDuration, timing.maxActionDuration);

  let petBox = { x: 0, y: 0, w: 0, h: 0 };
  let hearts = [];
  const REACTION_DURATION = 1200;

  let reacting = false;
  let cursorX = null;
  let cursorY = null;
  let cursorActive = false;
  let jumpCooldown = 0;
  const JUMP_BASE_HEIGHT = 30;
  let jumpHeight = 0;
  let jumpFrameDuration = null;

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function getScale() {
    return (config.scale || 1) * userScale;
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

  function resizeCanvas() {
    canvas.width = stage.clientWidth;
    canvas.height = stage.clientHeight;
  }
  window.addEventListener('resize', resizeCanvas);

  async function loadConfig() {
    const res = await fetch(configUri);
    config = await res.json();
    currentState = config.defaultState || 'idle';
  }

  function loadSprite() {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        spriteImage = img;
        spriteLoaded = true;
        resolve();
      };
      img.onerror = () => {
        spriteLoaded = false;
        resolve();
      };
      img.src = spriteUri;
    });
  }

  function pickNextAction() {
    moving = Math.random() < timing.moveChance;

    if (moving) {
      facing = Math.random() < 0.5 ? 1 : -1;
      currentState = facing === 1 ? config.movementStates.right : config.movementStates.left;
    } else {
      currentState = pickWeighted(config.idleStates);
    }
    stateDuration = randomBetween(timing.minActionDuration, timing.maxActionDuration);

    frameIndex = 0;
    frameTimer = 0;
    stateTimer = 0;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function activateReaction(stateName, duration) {
    const state = config.states[stateName];
    if (!state) return;

    currentState = stateName;
    moving = false;
    frameIndex = 0;
    frameTimer = 0;
    stateTimer = 0;
    reacting = true;
    stateDuration = duration ?? (state.loop ? REACTION_DURATION : (state.frameCount / state.fps) * 1000);
  }

  function activateJump(targetHeight) {
    const state = config.states.jump;
    if (!state) return;

    const naturalDuration = (state.frameCount / state.fps) * 1000;
    // Jumps are capped by the top of the window the pet is in, not a fixed height.
    const maxHeight = Math.max(JUMP_BASE_HEIGHT, petBox.y - 4);
    const height = clamp(targetHeight, JUMP_BASE_HEIGHT, maxHeight);
    // Taller jumps play out slower so the sprite has time to actually reach the apex.
    const durationScale = clamp(height / JUMP_BASE_HEIGHT, 1, maxHeight / JUMP_BASE_HEIGHT);
    const duration = naturalDuration * durationScale;

    currentState = 'jump';
    moving = false;
    frameIndex = 0;
    frameTimer = 0;
    stateTimer = 0;
    reacting = true;
    stateDuration = duration;
    jumpHeight = height;
    jumpFrameDuration = duration / state.frameCount;
  }

  function getVerticalOffset() {
    if (currentState !== 'jump' || !reacting || !jumpHeight) return 0;
    const progress = clamp(stateTimer / stateDuration, 0, 1);
    return Math.sin(progress * Math.PI) * jumpHeight;
  }

  function triggerReaction() {
    if (!config) return;
    const candidates = (config.reactionStates || []).filter((s) => config.states[s]);
    if (candidates.length === 0) return;
    const choice = candidates[Math.floor(Math.random() * candidates.length)];
    if (choice === 'jump') {
      activateJump(JUMP_BASE_HEIGHT);
    } else {
      activateReaction(choice, REACTION_DURATION);
    }
  }

  function chaseCursor(dt) {
    const spriteWidth = (config.frameWidth || 40) * getScale();
    const spriteCenter = x + spriteWidth / 2;
    const alignThreshold = spriteWidth / 3;
    const isAligned = Math.abs(cursorX - spriteCenter) <= alignThreshold;
    const isAbove = cursorY !== null && cursorY < petBox.y - 10;

    if (isAligned && isAbove && jumpCooldown <= 0 && config.states.jump) {
      activateJump(petBox.y - cursorY);
      jumpCooldown = timing.jumpCooldown;
      return;
    }

    const targetX = clamp(cursorX - spriteWidth / 2, 0, canvas.width - spriteWidth);
    const dx = targetX - x;
    const moveThreshold = 3;

    if (Math.abs(dx) <= moveThreshold) {
      if (moving) {
        moving = false;
        currentState = config.defaultState || 'idle';
        frameIndex = 0;
        frameTimer = 0;
      }
      return;
    }

    moving = true;
    const newFacing = dx > 0 ? 1 : -1;
    const desiredState = newFacing === 1 ? config.movementStates.right : config.movementStates.left;
    if (desiredState !== currentState) {
      facing = newFacing;
      currentState = desiredState;
      frameIndex = 0;
      frameTimer = 0;
    }

    const step = Math.min((timing.walkSpeed * dt) / 1000, Math.abs(dx));
    x += Math.sign(dx) * step;
    x = clamp(x, 0, canvas.width - spriteWidth);
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

  function drawAiBubble(now) {
    if (!aiBusy) return;

    const bubbleWidth = 34;
    const bubbleHeight = 20;
    const cx = petBox.x + petBox.w / 2;
    const bottomY = petBox.y - 6;
    const topY = bottomY - bubbleHeight;
    const left = clamp(cx - bubbleWidth / 2, 2, canvas.width - bubbleWidth - 2);

    ctx.save();
    ctx.fillStyle = 'rgba(20, 20, 20, 0.85)';
    roundRectPath(left, topY, bubbleWidth, bubbleHeight, 6);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx - 5, bottomY - 1);
    ctx.lineTo(cx + 5, bottomY - 1);
    ctx.lineTo(cx, bottomY + 6);
    ctx.closePath();
    ctx.fill();

    const dotCount = 1 + Math.floor((now / 400) % 3);
    ctx.fillStyle = '#f0f0f0';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('.'.repeat(dotCount), left + bubbleWidth / 2, topY + bubbleHeight / 2 - 1);
    ctx.restore();
  }

  function spawnHeart(cx, topY) {
    hearts.push({ x: cx + (Math.random() * 20 - 10), y: topY, life: 0, duration: 900 });
  }

  function updateHearts(dt) {
    for (const heart of hearts) heart.life += dt;
    hearts = hearts.filter((heart) => heart.life < heart.duration);
  }

  function drawHearts() {
    if (hearts.length === 0) return;
    ctx.save();
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    for (const heart of hearts) {
      const t = heart.life / heart.duration;
      ctx.globalAlpha = 1 - t;
      ctx.fillText('❤', heart.x, heart.y - t * 24);
    }
    ctx.restore();
  }

  canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    if (cx < petBox.x || cx > petBox.x + petBox.w || cy < petBox.y || cy > petBox.y + petBox.h) {
      return;
    }
    triggerReaction();
    spawnHeart(petBox.x + petBox.w / 2, petBox.y);
  });

  canvas.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    const hovering =
      cx >= petBox.x && cx <= petBox.x + petBox.w && cy >= petBox.y && cy <= petBox.y + petBox.h;
    canvas.style.cursor = hovering ? 'pointer' : 'default';

    cursorX = cx;
    cursorY = cy;
    cursorActive = true;
  });

  canvas.addEventListener('mouseleave', () => {
    cursorActive = false;
    cursorX = null;
    cursorY = null;
  });

  function drawPlaceholder(scale) {
    const w = 40 * scale;
    const h = 40 * scale;
    const groundY = canvas.height - h - getVerticalOffset();
    petBox = { x, y: groundY, w, h };
    ctx.save();
    ctx.translate(x, groundY);
    if (facing < 0) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.fillStyle = moving ? '#e0a13c' : '#c98a2e';
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#00000055';
    ctx.beginPath();
    ctx.arc(w * 0.32, h * 0.4, w * 0.06, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSprite(dt) {
    const state = config.states[currentState];
    if (!state) return;

    frameTimer += dt;
    const frameDuration =
      currentState === 'jump' && reacting && jumpFrameDuration ? jumpFrameDuration : 1000 / state.fps;
    if (frameTimer >= frameDuration) {
      frameTimer = 0;
      frameIndex += 1;
      if (frameIndex >= state.frameCount) {
        frameIndex = state.loop ? 0 : state.frameCount - 1;
      }
    }

    if (!spriteLoaded) {
      drawPlaceholder(getScale());
      return;
    }

    const { frameWidth, frameHeight } = config;
    const scale = getScale();
    const sx = frameIndex * frameWidth;
    const sy = state.row * frameHeight;
    const dw = frameWidth * scale;
    const dh = frameHeight * scale;
    const groundY = canvas.height - dh - getVerticalOffset();
    petBox = { x, y: groundY, w: dw, h: dh };

    ctx.drawImage(spriteImage, sx, sy, frameWidth, frameHeight, x, groundY, dw, dh);
  }

  let lastTime = performance.now();

  function tick(now) {
    const dt = now - lastTime;
    lastTime = now;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (jumpCooldown > 0) jumpCooldown -= dt;

    if (reacting) {
      stateTimer += dt;
      if (stateTimer >= stateDuration) {
        reacting = false;
      }
    } else if (cursorActive) {
      wasAiBusy = false;
      chaseCursor(dt);
    } else if (aiBusy && config.states[config.busyState]) {
      if (!wasAiBusy) {
        currentState = config.busyState;
        moving = false;
        frameIndex = 0;
        frameTimer = 0;
        wasAiBusy = true;
      }
    } else {
      if (wasAiBusy) {
        wasAiBusy = false;
        pickNextAction();
      }
      stateTimer += dt;
      if (stateTimer >= stateDuration) {
        pickNextAction();
      }

      if (moving) {
        x += (facing * timing.walkSpeed * dt) / 1000;
        const spriteWidth = (config.frameWidth || 40) * getScale();
        if (x <= 0) {
          x = 0;
          facing = 1;
          currentState = config.movementStates.right;
        } else if (x + spriteWidth >= canvas.width) {
          x = canvas.width - spriteWidth;
          facing = -1;
          currentState = config.movementStates.left;
        }
      }
    }

    drawSprite(dt);
    drawAiBubble(now);
    updateHearts(dt);
    drawHearts();

    requestAnimationFrame(tick);
  }

  (async function init() {
    resizeCanvas();
    await loadConfig();
    await loadSprite();
    requestAnimationFrame(tick);
  })();
})();
