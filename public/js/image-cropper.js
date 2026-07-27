/* =====================================================================
   IMAGE-CROPPER.JS — ครอบตัด + ย่อ/ขยายรูปผู้สมัครให้เป็นสี่เหลี่ยมจัตุรัส
   ทำงานด้วย <canvas> ล้วน ๆ ไม่พึ่งไลบรารีภายนอก (ใช้งานได้แม้ออฟไลน์)

   วิธีใช้:
     const blob = await openImageCropper(file);   // Blob (JPEG) หรือ null ถ้ายกเลิก

   หลักการ: รูปถูกวางบนเวที (stage) สี่เหลี่ยมจัตุรัส ผู้ใช้ลากเพื่อเลื่อน
   และเลื่อนแถบ/ล้อเมาส์เพื่อย่อ-ขยาย พื้นที่ที่เห็นทั้งเวทีคือส่วนที่จะถูกตัด
   แล้วส่งออกเป็นภาพจัตุรัสความละเอียด OUTPUT_SIZE
   ===================================================================== */
(function (global) {
  'use strict';

  const OUTPUT_SIZE = 512;   // ความละเอียดรูปที่ส่งออก (พิกเซล, จัตุรัส)
  const STAGE_SIZE = 340;    // ขนาดเวทีครอบตัดบนจอ (พิกเซล)
  const MAX_ZOOM = 4;        // ซูมได้สูงสุดกี่เท่าของขนาดพอดีกรอบ
  const ZOOM_STEP = 0.15;    // ขั้นการซูมด้วยล้อเมาส์

  let overlay, canvas, ctx, zoomRange;
  let resolvePromise = null;
  let state = null; // { img, iw, ih, baseScale, scale, ox, oy }
  let dragging = false, lastX = 0, lastY = 0;

  /* ---------- สร้าง DOM ของหน้าต่างครอบตัด (สร้างครั้งเดียว แล้วใช้ซ้ำ) ---------- */
  function buildDom() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.className = 'cropper-overlay';
    overlay.innerHTML = `
      <div class="cropper-window win-window">
        <div class="win-titlebar">
          <span>✂ ปรับแต่งรูปผู้สมัคร — ครอบตัด / ย่อ-ขยาย</span>
          <div class="win-buttons"><span class="cropper-x" title="ปิด" style="cursor:pointer;">✕</span></div>
        </div>
        <div class="win-body">
          <div class="cropper-stage">
            <canvas class="cropper-canvas"></canvas>
            <div class="cropper-frame"></div>
          </div>
          <div class="cropper-controls">
            <label class="cropper-zoom-label">🔍 ย่อ / ขยาย</label>
            <div class="cropper-zoom-row">
              <span>−</span>
              <input type="range" class="cropper-zoom" min="1" max="${MAX_ZOOM}" step="0.01" value="1">
              <span>＋</span>
            </div>
            <p class="cropper-hint">ลากรูปเพื่อเลื่อนตำแหน่ง • เลื่อนล้อเมาส์บนรูปเพื่อย่อ-ขยาย</p>
          </div>
          <div class="cropper-actions">
            <button type="button" class="btn btn-green cropper-ok">✔ ใช้รูปนี้</button>
            <button type="button" class="btn cropper-reset">↺ รีเซ็ต</button>
            <button type="button" class="btn cropper-cancel">ยกเลิก</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    canvas = overlay.querySelector('.cropper-canvas');
    canvas.width = STAGE_SIZE;
    canvas.height = STAGE_SIZE;
    canvas.style.width = STAGE_SIZE + 'px';
    canvas.style.height = STAGE_SIZE + 'px';
    ctx = canvas.getContext('2d');
    zoomRange = overlay.querySelector('.cropper-zoom');

    /* --- เหตุการณ์ต่าง ๆ --- */
    zoomRange.addEventListener('input', () => setZoom(parseFloat(zoomRange.value)));

    canvas.addEventListener('pointerdown', (e) => {
      if (!state) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging || !state) return;
      state.ox += e.clientX - lastX;
      state.oy += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      clampOffsets();
      draw();
    });
    const endDrag = (e) => {
      dragging = false;
      if (e.pointerId != null && canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('wheel', (e) => {
      if (!state) return;
      e.preventDefault();
      const cur = parseFloat(zoomRange.value);
      const next = Math.min(MAX_ZOOM, Math.max(1, cur + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
      zoomRange.value = next;
      setZoom(next);
    }, { passive: false });

    overlay.querySelector('.cropper-ok').addEventListener('click', onConfirm);
    overlay.querySelector('.cropper-reset').addEventListener('click', resetView);
    overlay.querySelector('.cropper-cancel').addEventListener('click', () => close(null));
    overlay.querySelector('.cropper-x').addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', (e) => {
      if (overlay.classList.contains('show') && e.key === 'Escape') close(null);
    });
  }

  /* ---------- คำนวณ / วาด ---------- */
  // จำกัดตำแหน่งไม่ให้เกิดขอบว่าง — รูปต้องคลุมเต็มเวทีเสมอ
  function clampOffsets() {
    const w = state.iw * state.scale;
    const h = state.ih * state.scale;
    state.ox = Math.min(0, Math.max(STAGE_SIZE - w, state.ox));
    state.oy = Math.min(0, Math.max(STAGE_SIZE - h, state.oy));
  }

  function draw() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, STAGE_SIZE, STAGE_SIZE);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.img, state.ox, state.oy, state.iw * state.scale, state.ih * state.scale);
  }

  // ซูมโดยตรึงจุดกึ่งกลางเวทีไว้กับที่
  function setZoom(factor) {
    if (!state) return;
    const newScale = state.baseScale * factor;
    const c = STAGE_SIZE / 2;
    const ratio = newScale / state.scale;
    state.ox = c - (c - state.ox) * ratio;
    state.oy = c - (c - state.oy) * ratio;
    state.scale = newScale;
    clampOffsets();
    draw();
  }

  function resetView() {
    if (!state) return;
    state.scale = state.baseScale;
    state.ox = (STAGE_SIZE - state.iw * state.scale) / 2;
    state.oy = (STAGE_SIZE - state.ih * state.scale) / 2;
    zoomRange.value = 1;
    clampOffsets();
    draw();
  }

  /* ---------- ส่งออกเป็น Blob (JPEG) ---------- */
  function exportBlob() {
    // แปลงพิกัดบนเวทีกลับเป็นพิกัดในภาพต้นฉบับ แล้วตัดเฉพาะส่วนที่เห็น
    const sx = -state.ox / state.scale;
    const sy = -state.oy / state.scale;
    const sSize = STAGE_SIZE / state.scale;

    const out = document.createElement('canvas');
    out.width = OUTPUT_SIZE;
    out.height = OUTPUT_SIZE;
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff'; // พื้นขาว เผื่อภาพต้นฉบับโปร่งใส
    octx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(state.img, sx, sy, sSize, sSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    return new Promise((resolve) => {
      out.toBlob((blob) => resolve(blob), 'image/jpeg', 0.9);
    });
  }

  async function onConfirm() {
    if (!state) return close(null);
    const okBtn = overlay.querySelector('.cropper-ok');
    okBtn.disabled = true;
    try {
      const blob = await exportBlob();
      close(blob);
    } finally {
      okBtn.disabled = false;
    }
  }

  /* ---------- เปิด / ปิดหน้าต่าง ---------- */
  function close(result) {
    if (!overlay) return;
    overlay.classList.remove('show');
    state = null;
    dragging = false;
    const fn = resolvePromise;
    resolvePromise = null;
    if (fn) fn(result);
  }

  function openImageCropper(file) {
    return new Promise((resolve, reject) => {
      buildDom();
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const iw = img.naturalWidth, ih = img.naturalHeight;
        if (!iw || !ih) return reject(new Error('ไฟล์รูปเสียหรืออ่านขนาดไม่ได้'));

        const baseScale = STAGE_SIZE / Math.min(iw, ih); // พอดีกรอบแบบคลุมเต็ม (cover)
        state = {
          img, iw, ih,
          baseScale,
          scale: baseScale,
          ox: (STAGE_SIZE - iw * baseScale) / 2,
          oy: (STAGE_SIZE - ih * baseScale) / 2,
        };
        zoomRange.value = 1;
        clampOffsets();
        draw();

        resolvePromise = resolve;
        overlay.classList.add('show');
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('เปิดไฟล์รูปนี้ไม่ได้'));
      };
      img.src = url;
    });
  }

  global.openImageCropper = openImageCropper;
})(window);
