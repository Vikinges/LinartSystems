(() => {
  const token = document.body.dataset.token || "";
  const canvas = document.querySelector("[data-signature-canvas]");
  const clearBtn = document.querySelector("[data-clear]");
  const submitBtn = document.querySelector("[data-submit]");
  const statusEl = document.querySelector("[data-status]");
  const commentEl = document.querySelector("[data-comment]");
  const downloadWrap = document.querySelector("[data-download]");
  const downloadLink = document.querySelector("[data-download-link]");

  if (!token || !canvas || !submitBtn) return;

  const ctx = canvas.getContext("2d");
  let drawing = false;
  let hasSignature = false;

  const resizeCanvas = () => {
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
  };

  const observer = new ResizeObserver(resizeCanvas);
  observer.observe(canvas);
  resizeCanvas();

  const getPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    const clientY = event.touches ? event.touches[0].clientY : event.clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  };

  const startDraw = (event) => {
    event.preventDefault();
    drawing = true;
    const point = getPoint(event);
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
  };

  const draw = (event) => {
    if (!drawing) return;
    event.preventDefault();
    const point = getPoint(event);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    hasSignature = true;
  };

  const endDraw = (event) => {
    if (!drawing) return;
    event.preventDefault();
    drawing = false;
    ctx.closePath();
  };

  const clearCanvas = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasSignature = false;
    setStatus("");
  };

  const setStatus = (message, isError = false) => {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle("error", Boolean(isError));
  };

  canvas.addEventListener("pointerdown", startDraw);
  canvas.addEventListener("pointermove", draw);
  canvas.addEventListener("pointerup", endDraw);
  canvas.addEventListener("pointerleave", endDraw);
  canvas.addEventListener("touchstart", startDraw, { passive: false });
  canvas.addEventListener("touchmove", draw, { passive: false });
  canvas.addEventListener("touchend", endDraw, { passive: false });

  if (clearBtn) {
    clearBtn.addEventListener("click", () => clearCanvas());
  }

  submitBtn.addEventListener("click", async () => {
    if (!hasSignature) {
      setStatus("Please add your signature before submitting.", true);
      return;
    }

    submitBtn.disabled = true;
    setStatus("Saving signature...");

    try {
      const payload = {
        signatureData: canvas.toDataURL("image/png"),
        comment: commentEl ? commentEl.value.trim() : "",
      };

      const response = await fetch(`/s/${encodeURIComponent(token)}/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data && data.error ? data.error : "Unable to save signature.");
      }

      setStatus("Signed successfully. You can download the final PDF now.");
      if (downloadWrap && downloadLink) {
        downloadLink.href = data.downloadUrl || `/s/${encodeURIComponent(token)}/download`;
        downloadWrap.hidden = false;
      }
    } catch (err) {
      setStatus(err.message || "Unable to save signature.", true);
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
