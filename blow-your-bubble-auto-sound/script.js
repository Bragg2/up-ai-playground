/*
  Blow Your Bubble
  p5.js + MediaPipe FaceMesh

  当前版本：
  - 一次吹出 1 个泡泡
  - 小泡泡概率更高，大泡泡概率更低
  - 整体泡泡速度变慢
  - 大泡泡仍然比小泡泡快一点
  - 所有泡泡都会飘远后再慢慢消失
  - 去掉音效按钮
  - 第一次点击/触摸画布后自动解锁音效
*/

// -------------------- Adjustable parameters --------------------
const PARAMS = {
  cameraW: 640,
  cameraH: 480,

  // Mouth / blow detection
  mouthOpenThreshold: 0.028,
  mouthRoundThreshold: 0.34,
  mouthNarrowThreshold: 0.42,
  blowShrinkThreshold: 0.085,
  bubbleSpawnCooldown: 390,
  detectionEveryNFrames: 2,

  // Bubble visuals
  bubbleSizeMin: 42,
  bubbleSizeMax: 145,

  // 速度单位是每帧像素。整体已经调慢。
  // 想更慢：继续降低这两个数。
  // 想更快：提高这两个数。
  bubbleUpSpeedMin: 0.65,
  bubbleUpSpeedMax: 1.85,

  // 左右漂移，越大越飘
  bubbleDrift: 0.45,

  // 泡泡淡出逻辑：
  // 先飘到屏幕上方一定距离后，才开始慢慢消失
  fadeStartYRatio: 0.18,
  fadeDistance: 220,

  // Wand image layout
  toolImageScale: 0.45,
  toolBottomOverflow: 0.06,
  toolRingYRatio: 0.215,
  toolRingXRatio: 0.5,
  toolRingRadiusRatio: 0.16,

  // UI
  videoAlpha: 245,
  backgroundBlurAlpha: 28,
  instructionTop: 18,
  showDebugHint: true,

  // Sound
  soundVolume: 0.28
};

// -------------------- Global variables --------------------
let video;
let wandImg;
let faceMesh;
let latestFace = null;
let faceReady = false;
let isDetecting = false;

let bubbles = [];
let ripples = [];

let lastMouthArea = null;
let lastBubbleTime = 0;
let frameForDetection = 0;

let audioCtx = null;
let soundUnlocked = false;

let currentMouthState = {
  isOShape: false,
  isBlowing: false,
  mouthX: 0,
  mouthY: 0,
  mouthArea: 0,
};

// MediaPipe landmark indexes
const LM = {
  upperLip: 13,
  lowerLip: 14,
  leftMouth: 61,
  rightMouth: 291,
  leftCheek: 234,
  rightCheek: 454,
  chin: 152,
  forehead: 10,
};

function preload() {
  wandImg = loadImage("bubble_wand.png");
}

function setup() {
  const cnv = createCanvas(windowWidth, windowHeight);
  cnv.parent("app");
  pixelDensity(1);

  setupCamera();
  setupFaceMesh();
  setupSoundAutoUnlock();
}

function draw() {
  background(0);

  drawCameraBackground();
  updateMouthState();
  maybeSpawnBubble();

  updateAndDrawBubbles();
  updateAndDrawRipples();
  drawBubbleWand();
  drawInstruction();
  drawDebugHint();

  frameForDetection++;
}

// -------------------- Camera --------------------
function setupCamera() {
  video = createCapture({
    video: {
      width: PARAMS.cameraW,
      height: PARAMS.cameraH,
      facingMode: "user",
    },
    audio: false,
  });

  video.size(PARAMS.cameraW, PARAMS.cameraH);
  video.hide();

  // Important for iPhone / iPad Safari.
  video.elt.setAttribute("playsinline", "");
  video.elt.setAttribute("webkit-playsinline", "");
  video.elt.muted = true;
}

// -------------------- Responsive layout --------------------
function isPortrait() {
  return height >= width;
}

function isMobileLike() {
  return isPortrait() || width < 820;
}

function getResponsiveParams() {
  const mobile = isMobileLike();
  const portrait = isPortrait();

  if (mobile && portrait) {
    return {
      toolImageScale: 0.64,
      toolBottomOverflow: -0.07,
      bubbleSizeMin: 34,
      bubbleSizeMax: 118,
      instructionTop: 14,
      backgroundBlurAlpha: 18,
      videoAlpha: 255,
    };
  }

  if (mobile && !portrait) {
    return {
      toolImageScale: 0.52,
      toolBottomOverflow: -0.02,
      bubbleSizeMin: 32,
      bubbleSizeMax: 104,
      instructionTop: 12,
      backgroundBlurAlpha: 18,
      videoAlpha: 255,
    };
  }

  return {
    toolImageScale: PARAMS.toolImageScale,
    toolBottomOverflow: PARAMS.toolBottomOverflow,
    bubbleSizeMin: PARAMS.bubbleSizeMin,
    bubbleSizeMax: PARAMS.bubbleSizeMax,
    instructionTop: PARAMS.instructionTop,
    backgroundBlurAlpha: PARAMS.backgroundBlurAlpha,
    videoAlpha: PARAMS.videoAlpha,
  };
}

function safeTopInset() {
  return isMobileLike() ? 10 : 0;
}

// -------------------- MediaPipe FaceMesh --------------------
function setupFaceMesh() {
  faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
  });

  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  faceMesh.onResults((results) => {
    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
      latestFace = results.multiFaceLandmarks[0];
      faceReady = true;
    } else {
      latestFace = null;
      faceReady = false;
    }
  });

  setTimeout(detectFaceLoop, 800);
}

async function detectFaceLoop() {
  if (!video || !video.elt || !faceMesh) {
    requestAnimationFrame(detectFaceLoop);
    return;
  }

  if (
    video.elt.readyState >= 2 &&
    !isDetecting &&
    frameForDetection % PARAMS.detectionEveryNFrames === 0
  ) {
    isDetecting = true;
    try {
      await faceMesh.send({ image: video.elt });
    } catch (err) {
      console.warn("FaceMesh detection error:", err);
    }
    isDetecting = false;
  }

  requestAnimationFrame(detectFaceLoop);
}

// -------------------- Camera layout --------------------
function getCoverVideoRect() {
  const vw = video.width || PARAMS.cameraW;
  const vh = video.height || PARAMS.cameraH;
  const scale = Math.max(width / vw, height / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = (width - dw) / 2;
  const dy = (height - dh) / 2;
  return { dx, dy, dw, dh, scale, vw, vh };
}

function drawCameraBackground() {
  const r = getCoverVideoRect();
  const rp = getResponsiveParams();

  push();
  tint(255, rp.videoAlpha);

  // 镜像自拍画面
  translate(width, 0);
  scale(-1, 1);
  image(video, width - r.dx - r.dw, r.dy, r.dw, r.dh);
  pop();

  noStroke();
  fill(0, rp.backgroundBlurAlpha);
  rect(0, 0, width, height);
}

function landmarkToScreen(lm) {
  const r = getCoverVideoRect();

  // MediaPipe 坐标不是镜像的；显示为自拍镜像后，需要翻转 x。
  const x = width - (r.dx + lm.x * r.dw);
  const y = r.dy + lm.y * r.dh;
  return createVector(x, y);
}

function landmarkToVideoPixel(lm) {
  return createVector(lm.x * video.width, lm.y * video.height);
}

function distLandmark(a, b) {
  return dist(a.x, a.y, b.x, b.y);
}

// -------------------- Mouth / blow detection --------------------
function updateMouthState() {
  currentMouthState.isOShape = false;
  currentMouthState.isBlowing = false;

  if (!faceReady || !latestFace) {
    lastMouthArea = null;
    return;
  }

  const upperLip = latestFace[LM.upperLip];
  const lowerLip = latestFace[LM.lowerLip];
  const leftMouth = latestFace[LM.leftMouth];
  const rightMouth = latestFace[LM.rightMouth];
  const leftCheek = latestFace[LM.leftCheek];
  const rightCheek = latestFace[LM.rightCheek];

  const mouthH = distLandmark(upperLip, lowerLip);
  const mouthW = distLandmark(leftMouth, rightMouth);
  const faceW = distLandmark(leftCheek, rightCheek);

  const openRatio = mouthH / faceW;
  const roundRatio = mouthH / max(mouthW, 0.0001);
  const narrowRatio = mouthW / faceW;
  const mouthArea = (mouthH * mouthW) / (faceW * faceW);

  const mouthCenter = landmarkToScreen({
    x: (leftMouth.x + rightMouth.x + upperLip.x + lowerLip.x) / 4,
    y: (leftMouth.y + rightMouth.y + upperLip.y + lowerLip.y) / 4,
  });

  const isOShape =
    openRatio > PARAMS.mouthOpenThreshold &&
    roundRatio > PARAMS.mouthRoundThreshold &&
    narrowRatio < PARAMS.mouthNarrowThreshold;

  let isBlowing = false;

  if (lastMouthArea !== null && isOShape) {
    const shrink = (lastMouthArea - mouthArea) / max(lastMouthArea, 0.0001);
    isBlowing = shrink > PARAMS.blowShrinkThreshold;
  }

  currentMouthState = {
    isOShape,
    isBlowing,
    mouthX: mouthCenter.x,
    mouthY: mouthCenter.y,
    mouthArea,
    openRatio,
    roundRatio,
    narrowRatio,
  };

  if (lastMouthArea === null) {
    lastMouthArea = mouthArea;
  } else {
    lastMouthArea = lerp(lastMouthArea, mouthArea, 0.42);
  }
}

function maybeSpawnBubble() {
  const now = millis();
  if (!currentMouthState.isBlowing) return;
  if (now - lastBubbleTime < PARAMS.bubbleSpawnCooldown) return;

  lastBubbleTime = now;

  const wand = getWandLayout();

  // 泡泡从泡泡棒大圆环附近出来，稍微参考嘴巴位置
  const followMouthAmount = isMobileLike() ? 0.18 : 0.35;
  const spawnX = lerp(wand.ringX, currentMouthState.mouthX || wand.ringX, followMouthAmount);
  const spawnY = lerp(wand.ringY, currentMouthState.mouthY || wand.ringY, followMouthAmount);

  const rp = getResponsiveParams();
  const bubbleSize = getRandomBubbleSize(rp);

  // 一次吹出 1 个泡泡
  bubbles.push(
    new Bubble(
      spawnX + random(-10, 10),
      spawnY + random(-8, 8),
      bubbleSize,
      rp
    )
  );

  ripples.push(new Ripple(wand.ringX, wand.ringY, wand.ringR));

  // 每次出现泡泡自动播放 pop
  playPopSound();
}

// 小泡泡概率更高，大泡泡概率更低
function getRandomBubbleSize(rp) {
  const t = random();

  if (t < 0.62) {
    // 小泡泡：最多
    return random(rp.bubbleSizeMin, rp.bubbleSizeMin + 34);
  } else if (t < 0.90) {
    // 中泡泡：其次
    return random(rp.bubbleSizeMin + 36, rp.bubbleSizeMax * 0.72);
  } else {
    // 大泡泡：少量
    return random(rp.bubbleSizeMax * 0.76, rp.bubbleSizeMax);
  }
}

// -------------------- Bubble class --------------------
class Bubble {
  constructor(x, y, size, rp) {
    this.x = x;
    this.y = y;

    this.baseSize = size;
    this.size = 8;
    this.targetSize = size;

    this.birthY = y;
    this.alpha = 255;

    // 0 = 最小泡泡，1 = 最大泡泡
    const size01 = constrain(
      (size - rp.bubbleSizeMin) / max(rp.bubbleSizeMax - rp.bubbleSizeMin, 0.0001),
      0,
      1
    );

    // 整体变慢后的速度倍率：
    // 小泡泡更慢，大泡泡快一点，但不会飞得太猛。
    const speedFactor = lerp(0.65, 1.45, size01);

    this.vy = -random(PARAMS.bubbleUpSpeedMin, PARAMS.bubbleUpSpeedMax) * speedFactor;

    // 大泡泡稍微更有横向漂移，小泡泡更轻
    this.vx = random(-0.12, 0.12) * lerp(0.8, 1.6, size01);

    this.phase = random(TWO_PI);
    this.rot = random(TWO_PI);
    this.rotSpeed = random(-0.003, 0.003);

    this.fadeStartY = height * PARAMS.fadeStartYRatio;
    this.fadeDistance = PARAMS.fadeDistance;

    this.crop = captureFaceTexture(size);
  }

  update() {
    this.size = lerp(
      this.size,
      this.targetSize * (1 + 0.035 * sin(frameCount * 0.045 + this.phase)),
      0.11
    );

    this.x += this.vx + sin(frameCount * 0.018 + this.phase) * PARAMS.bubbleDrift;
    this.y += this.vy;
    this.rot += this.rotSpeed;

    // 飘到屏幕上方后才开始慢慢消失
    if (this.y < this.fadeStartY) {
      const fadeT = constrain((this.fadeStartY - this.y) / this.fadeDistance, 0, 1);
      this.alpha = 255 * (1 - fadeT);
    } else {
      this.alpha = 255;
    }
  }

  isDead() {
    return this.alpha <= 2 || this.y + this.size < -80;
  }

  draw() {
    push();
    translate(this.x, this.y);
    rotate(this.rot);

    const s = this.size;
    const a = this.alpha;

    // 圆形裁切：把实时人像截成泡泡内部纹理
    drawingContext.save();
    drawingContext.beginPath();
    drawingContext.arc(0, 0, s / 2, 0, Math.PI * 2);
    drawingContext.clip();

    tint(255, a * 0.72);
    imageMode(CENTER);
    image(this.crop, 0, 0, s * 1.18, s * 1.18);

    noStroke();
    fill(255, 255, 255, a * 0.05);
    ellipse(-s * 0.08, -s * 0.10, s * 0.92, s * 0.92);

    drawingContext.restore();
    noTint();

    // 玻璃泡泡边缘 + 彩虹薄膜
    noFill();
    strokeWeight(max(1.2, s * 0.018));
    stroke(255, 255, 255, a * 0.58);
    ellipse(0, 0, s, s);

    strokeWeight(max(1, s * 0.012));
    stroke(255, 110, 190, a * 0.24);
    arc(0, 0, s * 0.96, s * 0.96, PI * 0.05, PI * 0.75);

    stroke(95, 210, 255, a * 0.22);
    arc(0, 0, s * 1.02, s * 1.02, PI * 0.88, PI * 1.55);

    stroke(255, 235, 120, a * 0.20);
    arc(0, 0, s * 0.90, s * 0.90, PI * 1.58, PI * 1.95);

    noStroke();
    fill(255, 255, 255, a * 0.72);
    ellipse(-s * 0.22, -s * 0.25, s * 0.16, s * 0.07);

    fill(255, 255, 255, a * 0.42);
    ellipse(s * 0.18, -s * 0.18, s * 0.08, s * 0.04);

    pop();
  }
}

function captureFaceTexture(size) {
  const g = createGraphics(size * 2, size * 2);
  g.pixelDensity(1);
  g.clear();

  if (!faceReady || !latestFace || !video) {
    g.background(255, 30);
    return g;
  }

  const forehead = landmarkToVideoPixel(latestFace[LM.forehead]);
  const chin = landmarkToVideoPixel(latestFace[LM.chin]);
  const leftCheek = landmarkToVideoPixel(latestFace[LM.leftCheek]);
  const rightCheek = landmarkToVideoPixel(latestFace[LM.rightCheek]);

  const cx = (leftCheek.x + rightCheek.x) / 2;
  const cy = (forehead.y + chin.y) / 2;
  const faceW = abs(rightCheek.x - leftCheek.x) * 1.65;
  const faceH = abs(chin.y - forehead.y) * 1.55;
  const cropSize = max(faceW, faceH, 100);

  const maxSx = max(0, video.width - cropSize);
  const maxSy = max(0, video.height - cropSize);
  const sx = constrain(cx - cropSize / 2, 0, maxSx);
  const sy = constrain(cy - cropSize / 2, 0, maxSy);

  // 泡泡内部也使用自拍镜像
  g.push();
  g.translate(g.width, 0);
  g.scale(-1, 1);
  g.image(video, 0, 0, g.width, g.height, sx, sy, cropSize, cropSize);
  g.pop();

  return g;
}

function updateAndDrawBubbles() {
  for (let i = bubbles.length - 1; i >= 0; i--) {
    bubbles[i].update();
    bubbles[i].draw();
    if (bubbles[i].isDead()) bubbles.splice(i, 1);
  }
}

// -------------------- Ripple feedback --------------------
class Ripple {
  constructor(x, y, startR) {
    this.x = x;
    this.y = y;
    this.startR = startR;
    this.birth = millis();
    this.life = 680;
  }

  draw() {
    const t = constrain((millis() - this.birth) / this.life, 0, 1);
    const r = this.startR + t * (isMobileLike() ? 70 : 105);
    const a = 190 * (1 - t);

    noFill();
    stroke(255, 255, 255, a);
    strokeWeight(2);
    ellipse(this.x, this.y, r * 2, r * 2);
  }

  isDead() {
    return millis() - this.birth > this.life;
  }
}

function updateAndDrawRipples() {
  for (let i = ripples.length - 1; i >= 0; i--) {
    ripples[i].draw();
    if (ripples[i].isDead()) ripples.splice(i, 1);
  }
}

// -------------------- Wand image --------------------
function getWandLayout() {
  const rp = getResponsiveParams();

  const toolH = height * rp.toolImageScale;
  const toolW = toolH * (wandImg.width / wandImg.height);
  const x = width / 2 - toolW / 2;
  const y = height - toolH + height * rp.toolBottomOverflow;

  const ringX = x + toolW * PARAMS.toolRingXRatio;
  const ringY = y + toolH * PARAMS.toolRingYRatio;
  const ringR = toolH * PARAMS.toolRingRadiusRatio;

  return { x, y, toolW, toolH, ringX, ringY, ringR };
}

function drawBubbleWand() {
  const w = getWandLayout();
  const pulse = millis() - lastBubbleTime < 260 ? 1.025 : 1;

  push();
  imageMode(CENTER);
  translate(w.x + w.toolW / 2, w.y + w.toolH / 2);
  scale(pulse);
  image(wandImg, 0, 0, w.toolW, w.toolH);
  pop();
}

// -------------------- UI --------------------
function drawInstruction() {
  const rp = getResponsiveParams();
  const mobile = isMobileLike();

  const boxW = mobile ? min(width - 28, 360) : min(width - 36, 430);
  const boxH = mobile ? 58 : 66;
  const x = width / 2 - boxW / 2;
  const y = rp.instructionTop + safeTopInset();

  push();
  rectMode(CORNER);
  noStroke();
  fill(255, 235);
  rect(x, y, boxW, boxH, mobile ? 14 : 12);

  fill(0);
  textAlign(CENTER, CENTER);
  textStyle(BOLD);
  textSize(mobile ? min(17, width * 0.046) : min(20, width * 0.047));
  text("用力吹出你的泡泡", width / 2, y + (mobile ? 21 : 24));

  textStyle(NORMAL);
  textSize(mobile ? min(12, width * 0.032) : min(14, width * 0.034));
  text("Make an O with your mouth and blow", width / 2, y + (mobile ? 42 : 48));
  pop();
}

function drawDebugHint() {
  if (!PARAMS.showDebugHint) return;

  push();

  const status = !faceReady
    ? "finding face..."
    : currentMouthState.isBlowing
      ? "blowing!"
      : currentMouthState.isOShape
        ? "O mouth detected"
        : "make an O";

  noStroke();
  fill(255, 210);
  textAlign(LEFT, BOTTOM);
  textSize(12);
  text(status, 14, height - 14);

  // 隐性提示：第一次点击画布后声音会自动开启
  if (!soundUnlocked) {
    textAlign(RIGHT, BOTTOM);
    text("tap once for sound", width - 14, height - 14);
  }

  pop();
}

// -------------------- Sound --------------------
function setupSoundAutoUnlock() {
  // 去掉按钮，只保留第一次点击/触摸画布自动解锁声音
  window.addEventListener("pointerdown", unlockSound, { once: true });
  window.addEventListener("touchstart", unlockSound, { once: true, passive: true });

  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  } catch (err) {
    console.warn("AudioContext init failed:", err);
  }
}

function unlockSound() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  audioCtx.resume().then(() => {
    soundUnlocked = true;
    console.log("Sound unlocked");
  }).catch((err) => {
    console.warn("Audio unlock failed:", err);
  });
}

function playPopSound() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (err) {
      console.warn("AudioContext create failed:", err);
      return;
    }
  }

  if (audioCtx.state === "suspended") {
    audioCtx.resume().then(() => {
      soundUnlocked = true;
    }).catch((err) => {
      console.warn("Audio resume failed:", err);
    });
  }

  // 没有用户第一次点击/触摸前，浏览器可能不允许播放
  if (!soundUnlocked) return;

  const now = audioCtx.currentTime;
  const volume = PARAMS.soundVolume;

  const master = audioCtx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(volume, now + 0.012);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
  master.connect(audioCtx.destination);

  // 1. 清脆 pop
  const osc1 = audioCtx.createOscillator();
  osc1.type = "sine";
  osc1.frequency.setValueAtTime(920, now);
  osc1.frequency.exponentialRampToValueAtTime(180, now + 0.16);
  osc1.connect(master);
  osc1.start(now);
  osc1.stop(now + 0.18);

  // 2. 低一点的 boing
  const osc2 = audioCtx.createOscillator();
  osc2.type = "triangle";
  osc2.frequency.setValueAtTime(220, now + 0.015);
  osc2.frequency.exponentialRampToValueAtTime(520, now + 0.075);
  osc2.frequency.exponentialRampToValueAtTime(130, now + 0.22);
  osc2.connect(master);
  osc2.start(now + 0.015);
  osc2.stop(now + 0.24);

  // 3. 很短的噗声 noise
  const bufferSize = Math.floor(audioCtx.sampleRate * 0.055);
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  }

  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;

  const noiseGain = audioCtx.createGain();
  noiseGain.gain.setValueAtTime(volume * 0.22, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

  noise.connect(noiseGain);
  noiseGain.connect(audioCtx.destination);
  noise.start(now);
  noise.stop(now + 0.065);
}

// -------------------- Resize --------------------
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
