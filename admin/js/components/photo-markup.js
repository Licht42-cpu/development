import { el } from '../../../shared/dom.js';
import { pushOverlay, removeOverlay } from '../lib/navigation.js';

/** A quick annotation pass over a just-captured photo -- drag to draw a red
 *  arrow or circle on whatever needs pointing out (a damage spot, a
 *  measurement reference) before it uploads. Offered on every photo, not
 *  gated to the damage/measurement tags specifically: the tag is chosen
 *  separately in field-photos.js, and gating the tool to a tag picked
 *  *after* the photo is taken would mean asking the tech to decide the tag
 *  before they've even seen whether the shot needs a mark on it.
 *
 *  Resolves to the composited (photo + marks) image as a Blob, or to the
 *  original file's bytes unchanged if the tech skips markup entirely --
 *  either way the caller gets back the same File-shaped thing it would
 *  have uploaded anyway. */
export function openPhotoMarkup(file, { cancelOnDismiss = false, current = () => true } = {}) {
  return new Promise((resolve) => {
    let tool = 'arrow';
    let drawing = false;
    let start = null;
    let img = null;
    let finished = false;
    let imageUrl;

    const overlay = el('div', {
      style: 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.85);' +
             'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px'
    });
    const canvas = el('canvas', {
      style: 'max-width:100%;max-height:70vh;touch-action:none;border-radius:8px;background:#000;cursor:crosshair'
    });
    const ctx = canvas.getContext('2d');

    function redraw(marks) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const m of marks) drawMark(ctx, m);
    }

    function drawMark(ctx2, m) {
      ctx2.strokeStyle = '#ff3b30';
      ctx2.lineWidth = Math.max(3, canvas.width * 0.006);
      ctx2.lineCap = 'round';
      if (m.tool === 'circle') {
        const rx = Math.abs(m.x2 - m.x1) / 2, ry = Math.abs(m.y2 - m.y1) / 2;
        const cx = (m.x1 + m.x2) / 2, cy = (m.y1 + m.y2) / 2;
        ctx2.beginPath(); ctx2.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx2.stroke();
      } else {
        drawArrow(ctx2, m.x1, m.y1, m.x2, m.y2);
      }
    }

    function drawArrow(ctx2, x1, y1, x2, y2) {
      const headLen = Math.max(14, canvas.width * 0.025);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      ctx2.beginPath(); ctx2.moveTo(x1, y1); ctx2.lineTo(x2, y2); ctx2.stroke();
      ctx2.beginPath();
      ctx2.moveTo(x2, y2);
      ctx2.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
      ctx2.moveTo(x2, y2);
      ctx2.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
      ctx2.stroke();
    }

    const marks = [];

    function pointFromEvent(e) {
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches?.[0];
      const clientX = touch ? touch.clientX : e.clientX;
      const clientY = touch ? touch.clientY : e.clientY;
      return {
        x: (clientX - rect.left) * (canvas.width / rect.width),
        y: (clientY - rect.top) * (canvas.height / rect.height)
      };
    }

    function onStart(e) { e.preventDefault(); drawing = true; start = pointFromEvent(e); }
    function onMove(e) {
      if (!drawing) return;
      e.preventDefault();
      const p = pointFromEvent(e);
      redraw(marks);
      drawMark(ctx, { tool, x1: start.x, y1: start.y, x2: p.x, y2: p.y });
    }
    function onEnd(e) {
      if (!drawing) return;
      drawing = false;
      const p = pointFromEvent(e.changedTouches ? { touches: e.changedTouches } : e);
      if (Math.hypot(p.x - start.x, p.y - start.y) > 8) {
        marks.push({ tool, x1: start.x, y1: start.y, x2: p.x, y2: p.y });
      }
      redraw(marks);
    }

    canvas.addEventListener('pointerdown', onStart);
    canvas.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    canvas.addEventListener('touchstart', onStart, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onEnd);

    /* Android Back (and Escape) must dismiss this layer rather than
       navigate the screen out from underneath it -- it is a fixed overlay
       on document.body, not a route, so nothing else would clean it up.
       Dismissing is Skip: the caller still gets the unmodified photo it
       was always going to get if the tech chose not to mark it up. */
    const backDismiss = () => finish(false, cancelOnDismiss);
    const cleanup = new MutationObserver(() => { if (!current()) finish(false, true); });

    function finish(useMarkup, cancelled = false) {
      if (finished) return;
      finished = true; cleanup.disconnect();
      removeOverlay(backDismiss);
      canvas.removeEventListener('pointerdown', onStart);
      canvas.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      overlay.remove();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      if (cancelled) return resolve(null);
      if (!useMarkup || marks.length === 0) return resolve(file);
      canvas.toBlob((blob) => {
        resolve(blob ? new File([blob], file.name, { type: 'image/png' }) : file);
      }, 'image/png');
    }

    const toolBtn = (label, value) => el('button', {
      class: `btn btn--sm${tool === value ? ' btn--primary' : ''}`, text: label, type: 'button',
      onClick: (e) => {
        tool = value;
        for (const b of toolRow.querySelectorAll('button')) b.classList.remove('btn--primary');
        e.currentTarget.classList.add('btn--primary');
      }
    });
    const toolRow = el('div', { class: 'btn-row' }, [toolBtn('↗ Arrow', 'arrow'), toolBtn('○ Circle', 'circle')]);

    const undoBtn = el('button', { class: 'btn btn--sm', text: 'Undo', type: 'button',
      onClick: () => { marks.pop(); redraw(marks); } });

    overlay.append(
      el('p', { style: 'color:#fff;margin:0 0 10px;font-weight:600', text: 'Mark up the photo (optional)' }),
      canvas,
      el('div', { class: 'btn-row', style: 'margin-top:12px' }, [toolRow, undoBtn]),
      el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
        ...(cancelOnDismiss ? [el('button', { class: 'btn', text: 'Keep draft', type: 'button', onClick: () => finish(false, true) })] : []),
        el('button', { class: 'btn', text: 'Skip', type: 'button', onClick: () => finish(false) }),
        el('button', { class: 'btn btn--primary', text: 'Use this photo', type: 'button', onClick: () => finish(true) })
      ])
    );
    document.body.append(overlay);
    pushOverlay(backDismiss);
    cleanup.observe(document.body, { childList: true, subtree: true });

    img = new Image();
    img.onload = () => {
      // Cap the working canvas at a sane display size -- a full-res phone
      // photo (often 3000px+) doesn't need to be the canvas's own pixel
      // size for a quick annotation pass, and toBlob() on a huge canvas is
      // slow on mobile hardware.
      const maxDim = 1600;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      redraw(marks);
    };
    imageUrl = URL.createObjectURL(file);
    img.src = imageUrl;
  });
}
