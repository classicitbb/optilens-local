/* Reusable printable-document preview for OptiLens modules. */
(function exposeDocumentPreview() {
  function sanitizeFilename(value) {
    return String(value || "document").replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim() || "document";
  }

  function open({ title, html, filename }) {
    let dialog = document.querySelector("#optilensDocumentPreview");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "optilensDocumentPreview";
      dialog.className = "document-preview-dialog";
      dialog.innerHTML = `<form method="dialog" class="document-preview-shell"><header><div><p class="eyebrow">Document preview</p><h2 data-preview-title></h2><small data-preview-print-note>Opens your browser print dialog.</small></div><div class="document-preview-actions"><button class="button secondary" type="button" data-preview-save>Save</button><button class="button primary" type="button" data-preview-print>Print</button><button class="button secondary" value="cancel" aria-label="Close document preview">Close</button></div></header><div class="document-preview-stage"><div class="document-preview-page"><iframe title="Document preview" data-preview-frame></iframe></div></div></form>`;
      document.body.append(dialog);
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
    }
    dialog.querySelector("[data-preview-title]").textContent = title || "Document";
    const frame = dialog.querySelector("[data-preview-frame]");
    frame.srcdoc = html;
    const safeFilename = sanitizeFilename(filename);
    dialog.querySelector("[data-preview-save]").onclick = async (event) => {
      const button = event.currentTarget;
      const previousLabel = button.textContent;
      button.disabled = true;
      button.textContent = "Creating PDF…";
      let blob;
      try {
        blob = await renderFrameAsPdf(frame);
      } catch (error) {
        console.error("Document PDF generation failed", error);
        button.disabled = false;
        button.textContent = previousLabel;
        return;
      }
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${safeFilename}.pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 0);
      button.disabled = false;
      button.textContent = previousLabel;
    };
    dialog.querySelector("[data-preview-print]").onclick = () => {
      // This web host exposes no native print bridge. Print the exact iframe,
      // which opens the browser's standard print dialog without pretending it
      // is a desktop-host system dialog.
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    };
    if (!dialog.open) dialog.showModal();
    return dialog;
  }

  async function renderFrameAsPdf(frame) {
    const doc = frame.contentDocument;
    if (!doc?.documentElement) throw new Error("Preview document is not ready.");
    await doc.fonts?.ready;
    const width = Math.max(816, doc.documentElement.scrollWidth, doc.body?.scrollWidth || 0);
    const height = Math.max(1056, doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0);
    const scale = 2;
    const serialized = new XMLSerializer().serializeToString(doc.documentElement);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
    const svgUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    const image = await loadImage(svgUrl);
    URL.revokeObjectURL(svgUrl);
    const pageHeight = 1056 * scale;
    const pages = [];
    for (let sourceY = 0; sourceY < image.height; sourceY += pageHeight) {
      const sourceHeight = Math.min(pageHeight, image.height - sourceY);
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = sourceHeight;
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, sourceY, image.width, sourceHeight, 0, 0, canvas.width, canvas.height);
      pages.push({ bytes: dataUrlBytes(canvas.toDataURL("image/jpeg", 0.94)), width: canvas.width, height: canvas.height });
    }
    return new Blob([buildPdf(pages)], { type: "application/pdf" });
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not render the document preview."));
      image.src = url;
    });
  }

  function dataUrlBytes(dataUrl) {
    const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function buildPdf(pages) {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n")];
    const offsets = [0];
    let length = chunks[0].length;
    const objects = [];
    const pageObjectIds = pages.map((_, index) => 3 + index * 3);
    objects.push(encoder.encode("<< /Type /Catalog /Pages 2 0 R >>"));
    objects.push(encoder.encode(`<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] >>`));
    pages.forEach((page, index) => {
      const pageId = pageObjectIds[index];
      const imageId = pageId + 1;
      const contentId = pageId + 2;
      const displayHeight = 612 * page.height / page.width;
      const content = `q\n612 0 0 ${displayHeight.toFixed(3)} 0 ${(792 - displayHeight).toFixed(3)} cm\n/Im${index} Do\nQ`;
      objects.push(encoder.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im${index} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
      objects.push([encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`), page.bytes, encoder.encode("\nendstream")]);
      objects.push(encoder.encode(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`));
    });
    objects.forEach((object, index) => {
      offsets.push(length);
      const prefix = encoder.encode(`${index + 1} 0 obj\n`);
      const suffix = encoder.encode("\nendobj\n");
      chunks.push(prefix); length += prefix.length;
      const objectChunks = Array.isArray(object) ? object : [object];
      objectChunks.forEach((chunk) => { chunks.push(chunk); length += chunk.length; });
      chunks.push(suffix); length += suffix.length;
    });
    const xref = length;
    const trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    chunks.push(encoder.encode(trailer));
    return new Blob(chunks, { type: "application/pdf" });
  }

  window.OptiLensDocumentPreview = Object.freeze({ open, sanitizeFilename });
}());
