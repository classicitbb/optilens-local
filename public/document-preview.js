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
      dialog.innerHTML = `<form method="dialog" class="document-preview-shell"><header><div><p class="eyebrow">Document preview</p><h2 data-preview-title></h2><small data-preview-print-note>Opens your browser print dialog.</small></div><div class="document-preview-actions"><button class="button secondary" type="button" data-preview-save>Save</button><button class="button primary" type="button" data-preview-print>Print</button><button class="launcher-close" value="cancel" aria-label="Close preview">&#x2715;</button></div></header><iframe title="Document preview" data-preview-frame></iframe></form>`;
      document.body.append(dialog);
    }
    dialog.querySelector("[data-preview-title]").textContent = title || "Document";
    const frame = dialog.querySelector("[data-preview-frame]");
    frame.srcdoc = html;
    const safeFilename = sanitizeFilename(filename);
    dialog.querySelector("[data-preview-save]").onclick = () => {
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${safeFilename}.html`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 0);
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

  window.OptiLensDocumentPreview = Object.freeze({ open, sanitizeFilename });
}());
