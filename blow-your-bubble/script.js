/*
  Blow Your Bubble - mobile friendly version
  HTML + p5.js + MediaPipe FaceMesh

  Deploy note:
  - Works on localhost or HTTPS.
  - Cloudflare Pages gives HTTPS by default, so phone camera permissions can work.
  - On mobile, open with Safari / Chrome. WeChat / RED built-in browsers may block camera.
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

  // Bubble visuals - desktop default
  bubblesPerBlowMin: 1,
  bubblesPerBlowMax: 3,
  bubbleSizeMin: 58,
  bubbleSizeMax: 145,
  bubbleLifeMin: 3600,
  bubbleLifeMax: 6800,
  bubbleUpSpeedMin: 0.45,
  bubbleUpSpeedMax: 1.35,
  bubbleDrift: 0.85,

  // Wand image layout - desktop default
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

  setupFaceMesh();
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
      // 手机竖屏：把泡泡棒放大并上移，让大圆环更接近用户嘴巴
      toolImageScale: 0.64,
      toolBottomOverflow: -0.07,
      bubbleSizeMin: 48,
      bubbleSizeMax: 118,
      instructionTop: 14,
      backgroundBlurAlpha: 18,
      videoAlpha: 255,
    };
  }

  if (mobile && !portrait) {
    return {
      // 手机横屏：泡泡棒不要太大，避免挡住整个脸
      toolImageScale: 0.52,
      toolBottomOverflow: -0.02,
      bubbleSizeMin: 44,
      bubbleSizeMax: 104,
      instructionTop: 12,
      backgroundBlurAlpha: 18,
      videoAlpha: 255,
    };
  }

  return {
    // 桌面端
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
  // iPhone 刘海屏安全距离的简单估计。
  // 真正的 CSS env(safe-area-inset-top) 在 canvas 里不易直接读取。
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

  // 镜像自拍画面。
  translate(width, 0);
  scale(-1, 1);
  image(video, width - r.dx - r.dw, r.dy, r.dw, r.dh);
  pop();

  // 轻微暗色遮罩，保留真人画面，同时让泡泡和红色工具更明显。
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

  // 平滑上一帧嘴巴面积，降低检测抖动。
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

  // 手机端让泡泡更稳定地从泡泡棒大圆环出来；桌面端稍微参考嘴巴位置。
  const followMouthAmount = isMobileLike() ? 0.18 : 0.35;
  const spawnX = lerp(wand.ringX, currentMouthState.mouthX || wand.ringX, followMouthAmount);
  const spawnY = lerp(wand.ringY, currentMouthState.mouthY || wand.ringY, followMouthAmount);

  const count = floor(random(PARAMS.bubblesPerBlowMin, PARAMS.bubblesPerBlowMax + 1));
  const rp = getResponsiveParams();

  for (let i = 0; i < count; i++) {
    bubbles.push(
      new Bubble(
        spawnX + random(-12, 12),
        spawnY + random(-10, 10),
        random(rp.bubbleSizeMin, rp.bubbleSizeMax)
      )
    );
  }

  ripples.push(new Ripple(wand.ringX, wand.ringY, wand.ringR));
}

// -------------------- Bubble class --------------------
class Bubble {
  constructor(x, y, size) {
    this.x = x;
    this.y = y;
    this.baseSize = size;
    this.size = 8;
    this.targetSize = size;
    this.birth = millis();
    this.life = random(PARAMS.bubbleLifeMin, PARAMS.bubbleLifeMax);
    this.vx = random(-0.25, 0.25);
    this.vy = -random(PARAMS.bubbleUpSpeedMin, PARAMS.bubbleUpSpeedMax);
    this.phase = random(TWO_PI);
    this.rot = random(TWO_PI);
    this.rotSpeed = random(-0.004, 0.004);
    this.crop = captureFaceTexture(size);
  }

  update() {
    const age = millis() - this.birth;
    const t = constrain(age / this.life, 0, 1);

    this.size = lerp(
      this.size,
      this.targetSize * (1 + 0.035 * sin(frameCount * 0.06 + this.phase)),
      0.12
    );

    this.x += this.vx + sin(frameCount * 0.025 + this.phase) * PARAMS.bubbleDrift;
    this.y += this.vy;
    this.rot += this.rotSpeed;
    this.alpha = 255 * (1 - t);
  }

  isDead() {
    return this.alpha <= 2 || this.y + this.size < -40;
  }

  draw() {
    push();
    translate(this.x, this.y);
    rotate(this.rot);

    const s = this.size;
    const a = this.alpha;

    // 圆形裁切：把实时人像截成泡泡内部纹理。
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

    // 玻璃泡泡边缘 + 彩虹薄膜。
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

  // 泡泡内部也使用自拍镜像。
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
  pop();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
