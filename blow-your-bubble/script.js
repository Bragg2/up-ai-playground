/*
  Blow Your Bubble - V2
  修复重点：
  1. 增加明确的“开启音效”按钮，点击后立即播放测试音。
  2. 泡泡上升速度更快、生命周期更长，可以明显飘离嘴巴附近。
*/

const PARAMS = {
  mouthOpenThreshold: 0.018,
  mouthRoundRatioMin: 0.24,
  mouthRoundRatioMax: 0.82,
  blowShrinkThreshold: 0.0035,

  bubbleSpawnCooldown: 8,
  bubbleCountMin: 3,
  bubbleCountMax: 7,

  bubbleSizeMin: 18,
  bubbleSizeMax: 210,

  videoAlpha: 250,
  backgroundBlurAlpha: 20,

  toolImageScale: 0.45,
  toolBottomOverflow: 0.06,
  bubbleOriginXOffset: 0,
  bubbleOriginYOffset: 0,
  instructionTop: 18,

  soundEnabled: true,
  soundVolume: 0.85,
  debug: false
};

let video;
let faceMesh;
let faceResults = null;
let bubbleWand;
let bubbles = [];
let ripples = [];
let lastMouthArea = null;
let cooldown = 0;
let cameraReady = false;

let audioCtx = null;
let masterGain = null;
let soundUnlocked = false;

const MOUTH = {
  leftCorner: 61,
  rightCorner: 291,
  upperLip: 13,
  lowerLip: 14
};

function preload() {
  bubbleWand = loadImage("./bubble_wand.png");
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);

  setupSoundButton();
  setupCamera();
  setupFaceMesh();

  textFont("Helvetica Neue, Arial, sans-serif");
}

function setupSoundButton() {
  const btn = document.getElementById("soundButton");
  if (btn) {
    btn.addEventListener("pointerdown", async (e) => {
      e.preventDefault();
      await unlockAudio();
    });
  }

  // 保险：点击画布任意位置也尝试解锁
  window.addEventListener("pointerdown", async () => {
    if (!soundUnlocked) await unlockAudio(false);
  });
}

function setupCamera() {
  video = createCapture(
    {
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    },
    () => {
      cameraReady = true;
      const loading = document.getElementById("loading");
      if (loading) loading.style.display = "none";
    }
  );

  video.size(640, 480);
  video.hide();
}

function setupFaceMesh() {
  faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
  });

  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  faceMesh.onResults((results) => {
    faceResults = results;
  });

  const camera = new Camera(video.elt, {
    onFrame: async () => {
      if (video && video.elt && video.elt.readyState >= 2) {
        await faceMesh.send({ image: video.elt });
      }
    },
    width: 640,
    height: 480
  });

  camera.start();
}

function draw() {
  background(0);
  const rp = getResponsiveParams();

  drawCameraBackground(rp);
  detectBlowAndSpawnBubbles(rp);
  updateAndDrawBubbles();
  drawBubbleWand(rp);
  updateAndDrawRipples();
  drawInstruction(rp);
  drawSoundHint();
  drawDebug(rp);

  if (cooldown > 0) cooldown--;
}

function isMobileLike() {
  return width <= 820 || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isPortrait() {
  return height >= width;
}

function getResponsiveParams() {
  const mobile = isMobileLike();
  const portrait = isPortrait();

  if (mobile && portrait) {
    return {
      ...PARAMS,
      toolImageScale: 0.64,
      toolBottomOverflow: -0.07,
      bubbleSizeMin: 16,
      bubbleSizeMax: 190,
      instructionTop: 14,
      backgroundBlurAlpha: 16,
      videoAlpha: 255,
      bubbleOriginYOffset: -10
    };
  }

  if (mobile && !portrait) {
    return {
      ...PARAMS,
      toolImageScale: 0.52,
      toolBottomOverflow: -0.02,
      bubbleSizeMin: 16,
      bubbleSizeMax: 170,
      instructionTop: 12,
      backgroundBlurAlpha: 18,
      videoAlpha: 255,
      bubbleOriginYOffset: -8
    };
  }

  return {
    ...PARAMS,
    toolImageScale: 0.45,
    toolBottomOverflow: 0.06,
    bubbleSizeMin: 18,
    bubbleSizeMax: 230,
    instructionTop: 18,
    backgroundBlurAlpha: 22,
    videoAlpha: 250,
    bubbleOriginYOffset: -8
  };
}

function drawCameraBackground(rp) {
  if (!video || video.width === 0 || video.height === 0) return;
  const r = getCoverVideoRect();

  push();
  tint(255, rp.videoAlpha);
  translate(width, 0);
  scale(-1, 1);
  image(video, width - r.dx - r.dw, r.dy, r.dw, r.dh);
  pop();

  noStroke();
  fill(0, rp.backgroundBlurAlpha);
  rect(0, 0, width, height);
}

function getCoverVideoRect() {
  const vw = video.width || 640;
  const vh = video.height || 480;
  const canvasRatio = width / height;
  const videoRatio = vw / vh;
  let dw, dh, dx, dy;

  if (videoRatio > canvasRatio) {
    dh = height;
    dw = dh * videoRatio;
    dx = (width - dw) / 2;
    dy = 0;
  } else {
    dw = width;
    dh = dw / videoRatio;
    dx = 0;
    dy = (height - dh) / 2;
  }
  return { dx, dy, dw, dh };
}

function detectBlowAndSpawnBubbles(rp) {
  if (!faceResults || !faceResults.multiFaceLandmarks || faceResults.multiFaceLandmarks.length === 0) {
    lastMouthArea = null;
    return;
  }

  const landmarks = faceResults.multiFaceLandmarks[0];
  const left = landmarks[MOUTH.leftCorner];
  const right = landmarks[MOUTH.rightCorner];
  const upper = landmarks[MOUTH.upperLip];
  const lower = landmarks[MOUTH.lowerLip];
  if (!left || !right || !upper || !lower) return;

  const mouthWidth = distNorm(left, right);
  const mouthHeight = distNorm(upper, lower);
  const mouthArea = mouthWidth * mouthHeight;
  const roundRatio = mouthHeight / max(mouthWidth, 0.0001);

  const isOpen = mouthHeight > rp.mouthOpenThreshold;
  const isRound = roundRatio > rp.mouthRoundRatioMin && roundRatio < rp.mouthRoundRatioMax;

  let isShrinking = false;
  if (lastMouthArea !== null) {
    const shrinkAmount = lastMouthArea - mouthArea;
    isShrinking = shrinkAmount > rp.blowShrinkThreshold;
  }
  lastMouthArea = lerp(lastMouthArea || mouthArea, mouthArea, 0.55);

  if (isOpen && isRound && isShrinking && cooldown <= 0) {
    const origin = getBubbleOriginFromWand(rp);
    spawnBubbles(origin.x, origin.y, rp);
    ripples.push(new Ripple(origin.x, origin.y));
    playPopSound();
    cooldown = rp.bubbleSpawnCooldown;
  }
}

function distNorm(a, b) {
  return dist(a.x, a.y, b.x, b.y);
}

function getBubbleOriginFromWand(rp) {
  const toolH = height * rp.toolImageScale;
  const toolBottom = height + toolH * rp.toolBottomOverflow;
  const toolTop = toolBottom - toolH;
  return {
    x: width / 2 + rp.bubbleOriginXOffset,
    y: toolTop + toolH * 0.14 + rp.bubbleOriginYOffset
  };
}

function spawnBubbles(originX, originY, rp) {
  const count = floor(random(rp.bubbleCountMin, rp.bubbleCountMax + 1));

  for (let i = 0; i < count; i++) {
    const size = getRandomBubbleSize(rp);
    const offsetX = random(-46, 46);
    const offsetY = random(-28, 12);
    const b = new Bubble(originX + offsetX, originY + offsetY, size, rp);
    bubbles.push(b);
  }
}

function getRandomBubbleSize(rp) {
  const t = random();
  if (t < 0.62) return random(rp.bubbleSizeMin, rp.bubbleSizeMin + 42);
  if (t < 0.9) return random(rp.bubbleSizeMin + 48, rp.bubbleSizeMax * 0.62);
  return random(rp.bubbleSizeMax * 0.68, rp.bubbleSizeMax);
}

class Bubble {
  constructor(x, y, size, rp) {
    this.x = x;
    this.y = y;
    this.baseSize = size;
    this.size = size;

    // 这版明显更快：每帧上移 12–24px 左右，且继续加速
    const speedFactor = map(size, 16, 230, 1.22, 0.78, true);
    this.vy = random(-12.0, -24.0) * speedFactor;
    this.ay = random(-0.025, -0.07);

    // 让泡泡不只停在嘴巴上方，会更散开
    this.vx = random(-2.1, 2.1);

    this.age = 0;
    this.maxLife = random(150, 260);
    this.life = 255;

    this.swingAmp = random(0.8, 4.5);
    this.swingSpeed = random(0.03, 0.08);
    this.phase = random(TWO_PI);
    this.rotation = random(TWO_PI);
    this.rotationSpeed = random(-0.024, 0.024);
    this.popScale = 0.08;

    this.capture = null;
    this.captureVideoPatch();
  }

  captureVideoPatch() {
    if (!video || video.width === 0 || video.height === 0) return;
    const patchSize = min(video.width, video.height) * random(0.42, 0.74);
    const sx = video.width / 2 - patchSize / 2 + random(-70, 70);
    const sy = video.height * random(0.16, 0.38);
    this.capture = video.get(
      constrain(sx, 0, video.width - patchSize),
      constrain(sy, 0, video.height - patchSize),
      patchSize,
      patchSize
    );
  }

  update() {
    this.age++;
    this.vy += this.ay;
    this.y += this.vy;
    this.x += this.vx + sin(this.age * this.swingSpeed + this.phase) * this.swingAmp;
    this.rotation += this.rotationSpeed;
    this.popScale = min(1, this.popScale + 0.12);
    this.size = this.baseSize * this.popScale * (1 + sin(this.age * 0.07 + this.phase) * 0.045);

    // 前 60% 几乎不透明，后面再淡出，避免刚离开嘴边就消失
    const fadeStart = this.maxLife * 0.6;
    if (this.age < fadeStart) this.life = 255;
    else this.life = map(this.age, fadeStart, this.maxLife, 255, 0, true);
  }

  draw() {
    push();
    translate(this.x, this.y);
    rotate(this.rotation);
    const alpha = this.life;
    const s = this.size;

    if (this.capture) {
      push();
      drawingContext.save();
      drawingContext.beginPath();
      drawingContext.arc(0, 0, s / 2, 0, Math.PI * 2);
      drawingContext.clip();
      tint(255, alpha * 0.75);
      imageMode(CENTER);
      image(this.capture, 0, 0, s * 1.26, s * 1.26);
      noStroke();
      fill(255, alpha * 0.08);
      ellipse(0, 0, s, s);
      drawingContext.restore();
      pop();
    }

    noFill();
    strokeWeight(max(1, s * 0.026));
    stroke(255, alpha * 0.66);
    ellipse(0, 0, s, s);

    strokeWeight(max(1, s * 0.012));
    stroke(255, 170, 230, alpha * 0.35);
    ellipse(0, 0, s * 0.96, s * 0.96);
    stroke(150, 225, 255, alpha * 0.34);
    ellipse(0, 0, s * 0.9, s * 0.9);
    stroke(255, 246, 160, alpha * 0.25);
    ellipse(0, 0, s * 0.84, s * 0.84);

    noStroke();
    fill(255, alpha * 0.72);
    ellipse(-s * 0.18, -s * 0.22, s * 0.18, s * 0.08);
    fill(255, alpha * 0.4);
    ellipse(s * 0.18, s * 0.12, s * 0.08, s * 0.04);

    noFill();
    stroke(255, alpha * 0.14);
    strokeWeight(max(1, s * 0.045));
    ellipse(0, 0, s * 1.04, s * 1.04);
    pop();
  }

  isDead() {
    return this.life <= 0 || this.y < -this.size * 2;
  }
}

function updateAndDrawBubbles() {
  for (let i = bubbles.length - 1; i >= 0; i--) {
    bubbles[i].update();
    bubbles[i].draw();
    if (bubbles[i].isDead()) bubbles.splice(i, 1);
  }
}

function drawBubbleWand(rp) {
  if (!bubbleWand) return;
  const toolH = height * rp.toolImageScale;
  const toolW = toolH * (bubbleWand.width / bubbleWand.height);
  const x = width / 2;
  const toolBottom = height + toolH * rp.toolBottomOverflow;
  const y = toolBottom - toolH / 2;

  push();
  imageMode(CENTER);
  const pulse = cooldown > rp.bubbleSpawnCooldown - 5 ? 1.045 : 1;
  image(bubbleWand, x, y, toolW * pulse, toolH * pulse);
  pop();
}

class Ripple {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.r = 8;
    this.alpha = 190;
  }
  update() {
    this.r += 7.2;
    this.alpha *= 0.86;
  }
  draw() {
    push();
    noFill();
    stroke(255, this.alpha);
    strokeWeight(2);
    ellipse(this.x, this.y, this.r, this.r);
    stroke(180, 220, 255, this.alpha * 0.45);
    ellipse(this.x, this.y, this.r * 1.35, this.r * 1.35);
    pop();
  }
  isDead() {
    return this.alpha < 3;
  }
}

function updateAndDrawRipples() {
  for (let i = ripples.length - 1; i >= 0; i--) {
    ripples[i].update();
    ripples[i].draw();
    if (ripples[i].isDead()) ripples.splice(i, 1);
  }
}

function drawInstruction(rp) {
  push();
  const boxW = min(width * 0.88, 520);
  const boxH = isMobileLike() ? 58 : 62;
  const x = width / 2;
  const y = rp.instructionTop + boxH / 2;
  rectMode(CENTER);
  noStroke();
  fill(255, 210);
  rect(x, y, boxW, boxH, 18);
  fill(0, 220);
  textAlign(CENTER, CENTER);
  textSize(isMobileLike() ? 15 : 17);
  text("张圆嘴巴，用力吹出你的泡泡", x, y - 10);
  textSize(isMobileLike() ? 11 : 12);
  fill(0, 150);
  text("Make an O with your mouth and blow", x, y + 13);
  pop();
}

function drawSoundHint() {
  if (soundUnlocked) return;
  push();
  textAlign(CENTER, CENTER);
  noStroke();
  fill(255, 235);
  rectMode(CENTER);
  const y = height - 82;
  rect(width / 2, y, min(width * 0.78, 360), 34, 18);
  fill(0, 200);
  textSize(12);
  text("点击下方按钮开启音效 / Tap to enable sound", width / 2, y + 1);
  pop();
}

function drawDebug(rp) {
  if (!PARAMS.debug) return;
  const d = document.getElementById("debugText");
  if (!d) return;
  d.style.display = "block";
  d.innerText = `soundUnlocked: ${soundUnlocked} | audio: ${audioCtx ? audioCtx.state : "none"} | bubbles: ${bubbles.length}`;
}

async function unlockAudio(playTest = true) {
  if (!PARAMS.soundEnabled) return;
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = PARAMS.soundVolume;
      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state !== "running") await audioCtx.resume();
    soundUnlocked = true;

    const btn = document.getElementById("soundButton");
    if (btn) {
      btn.classList.add("enabled");
      setTimeout(() => { btn.style.display = "none"; }, 420);
    }

    if (playTest) playPopSound(true);
  } catch (err) {
    console.warn("Audio unlock failed:", err);
  }
}

function playPopSound(isTest = false) {
  if (!PARAMS.soundEnabled) return;
  if (!audioCtx || !masterGain || audioCtx.state !== "running") return;

  const now = audioCtx.currentTime;
  const out = audioCtx.createGain();
  out.gain.setValueAtTime(0.0001, now);
  out.gain.exponentialRampToValueAtTime(isTest ? 0.95 : 0.75, now + 0.012);
  out.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
  out.connect(masterGain);

  // 明显的“啵”声：短噪音 + 音高下滑
  const osc1 = audioCtx.createOscillator();
  osc1.type = "square";
  osc1.frequency.setValueAtTime(860, now);
  osc1.frequency.exponentialRampToValueAtTime(140, now + 0.16);
  osc1.connect(out);
  osc1.start(now);
  osc1.stop(now + 0.19);

  const osc2 = audioCtx.createOscillator();
  osc2.type = "sine";
  osc2.frequency.setValueAtTime(240, now + 0.015);
  osc2.frequency.exponentialRampToValueAtTime(560, now + 0.08);
  osc2.frequency.exponentialRampToValueAtTime(180, now + 0.26);
  osc2.connect(out);
  osc2.start(now + 0.015);
  osc2.stop(now + 0.28);

  // 噗的一下，让电脑扬声器也明显听见
  const bufferSize = Math.floor(audioCtx.sampleRate * 0.08);
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    const decay = 1 - i / bufferSize;
    data[i] = (Math.random() * 2 - 1) * decay;
  }
  const noise = audioCtx.createBufferSource();
  const filter = audioCtx.createBiquadFilter();
  const noiseGain = audioCtx.createGain();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(1200, now);
  filter.Q.setValueAtTime(0.9, now);
  noiseGain.gain.setValueAtTime(isTest ? 0.55 : 0.38, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  noise.buffer = buffer;
  noise.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(out);
  noise.start(now);
  noise.stop(now + 0.085);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
