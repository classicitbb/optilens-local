(() => {
  const form = document.getElementById("rxForm");
  if (!form) return;

  const state = { catalog: [], stagedFiles: [] };
  const $ = (selector) => document.querySelector(selector);
  const status = $("#rxStatus");
  const setStatus = (message, kind = "") => {
    status.textContent = message;
    status.className = `rx-status show ${kind}`;
  };
  const clearStatus = () => { status.className = "rx-status"; status.textContent = ""; };
  const request = async (url, options = {}) => {
    const response = await fetch(url, { credentials: "same-origin", ...options });
    const type = response.headers.get("content-type") || "";
    if (!response.ok) {
      const payload = type.includes("json") ? await response.json().catch(() => ({})) : {};
      throw new Error(payload.error || `Request failed (${response.status}).`);
    }
    return response;
  };
  const postJson = (url, body) => request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const formValue = (name) => form.elements[name]?.value ?? "";

  function toggleConditionalFields() {
    const patientMode = formValue("patientMode");
    $(".rx-patient-fixed").hidden = patientMode !== "fixed";
    $(".rx-patient-list").hidden = patientMode !== "list";
    $(".rx-lens-alias").hidden = formValue("lensMode") !== "fixed";
    $(".rx-fixed-rx").hidden = formValue("prescriptionMode") !== "fixed";
    $("#coatingSkuWrap").hidden = formValue("coatingMode") !== "fixed";
  }

  function fillSelect(select, items, label) {
    select.replaceChildren(...items.map((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      return option;
    }));
  }

  function syncLensOptions() {
    const category = formValue("lensCatalog");
    const aliases = state.catalog.filter((item) => category === "All valid lenses" || item.category === category);
    fillSelect($("#lensAlias"), aliases.map((item) => ({ value: item.alias, label: `${item.alias} · ${item.materialDescription} · ${item.styleDescription}` })));
  }

  function payload() {
    const patientMode = formValue("patientMode");
    const lensMode = formValue("lensMode");
    const prescriptionMode = formValue("prescriptionMode");
    const frameMode = formValue("frameMode");
    return {
      batchSize: Number(formValue("batchSize")),
      randomSeed: formValue("randomSeed"),
      extension: formValue("extension"),
      instructions: formValue("instructions"),
      labNum: formValue("labNum"),
      remoteOperator: formValue("remoteOperator"),
      customer: { custNum: formValue("custNum"), custSeqNum: formValue("custSeqNum"), shipName: formValue("shipName") },
      patient: { mode: patientMode, name: formValue("patientName"), names: formValue("patientNames") },
      lens: { mode: lensMode, catalog: formValue("lensCatalog"), alias: formValue("lensAlias"), unique: form.elements.uniqueAliases.checked },
      prescription: {
        mode: prescriptionMode, pdOd: Number(formValue("pdOd")), pdOs: Number(formValue("pdOs")),
        od: { sphere: Number(formValue("odSphere")), cylinder: Number(formValue("odCylinder")), axis: Number(formValue("odAxis")), add: Number(formValue("odAdd")), segHeight: Number(formValue("odSegHeight")) },
        os: { sphere: Number(formValue("osSphere")), cylinder: Number(formValue("osCylinder")), axis: Number(formValue("osAxis")), add: Number(formValue("osAdd")), segHeight: Number(formValue("osSegHeight")) }
      },
      frame: { mode: frameMode, model: formValue("frameModel"), color: formValue("frameColor"), a: Number(formValue("frameA")), b: Number(formValue("frameB")), dbl: Number(formValue("frameDbl")) },
      coating: { mode: formValue("coatingMode"), sku: formValue("coatingSku") },
      addons: { skus: [...document.querySelectorAll("#rxAddons input:checked")].map((input) => input.value) }
    };
  }

  function showPreview(preview) {
    $("#rxFilename").textContent = preview.filename;
    $("#rxPatient").textContent = preview.summary.patient;
    $("#rxLens").textContent = preview.summary.lens;
    $("#rxFrame").textContent = preview.summary.frame;
    $("#rxContent").textContent = preview.content;
  }

  async function preview() {
    clearStatus();
    const response = await postJson("/api/rx/preview", payload());
    const result = await response.json();
    showPreview(result);
    setStatus("Preview validated. Review the raw line order before staging or download.", "success");
  }

  async function stage() {
    clearStatus();
    const response = await postJson("/api/rx/generate", { ...payload(), delivery: "stage" });
    const result = await response.json();
    state.stagedFiles = result.generated.map((item) => item.filename);
    $("#releaseRx").disabled = !state.stagedFiles.length;
    setStatus(`${result.batchSize} RX ${result.batchSize === 1 ? "file was" : "files were"} safely staged.`, "success");
  }

  async function download() {
    clearStatus();
    const response = await postJson("/api/rx/generate", payload());
    const content = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] || "rx-files.zip";
    const link = document.createElement("a");
    link.href = URL.createObjectURL(content);
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setStatus(`${response.headers.get("x-rx-generated-count") || "RX"} file(s) generated, staged, and downloaded.`, "success");
  }

  async function release() {
    clearStatus();
    if (!state.stagedFiles.length) throw new Error("Stage a batch before releasing it.");
    const response = await postJson("/api/rx/release", { filenames: state.stagedFiles });
    const result = await response.json();
    setStatus(`${result.released.length} staged file(s) released to the configured incoming folder.`, "success");
  }

  async function run(action) {
    try { await action(); } catch (error) { setStatus(error.message || "The RX request could not be completed.", "error"); }
  }

  async function load() {
    try {
      const [catalogResponse, coatingResponse, addonResponse] = await Promise.all([request("/api/rx/catalog"), request("/api/rx/coatings"), request("/api/rx/addons")]);
      const [catalog, coatings, addons] = await Promise.all([catalogResponse.json(), coatingResponse.json(), addonResponse.json()]);
      state.catalog = catalog.items || [];
      const categories = [...new Set(state.catalog.map((item) => item.category))].sort();
      fillSelect($("#lensCatalog"), [{ value: "All valid lenses", label: "All valid lenses" }, ...categories.map((item) => ({ value: item, label: item }))]);
      syncLensOptions();
      fillSelect($("#coatingSku"), (coatings.items || []).map((item) => ({ value: item.sku, label: `${item.description} (${item.sku})` })));
      const addonList = document.createElement("div");
      addonList.className = "rx-addon-list";
      (addons.items || []).forEach((item) => {
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox"; checkbox.value = item.sku;
        label.append(checkbox, document.createTextNode(` ${item.description} (${item.sku})`));
        addonList.append(label);
      });
      $("#rxAddons").replaceChildren(addonList);
      setStatus(`${state.catalog.length} valid lens aliases loaded. This starter catalogue is for test-only generation.`, "success");
    } catch (error) { setStatus(error.message || "Unable to load RX generator data.", "error"); }
  }

  document.querySelectorAll(".workflow-tabs button").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".workflow-tabs button").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll(".workflow-panel").forEach((panel) => panel.classList.toggle("active", panel.id === button.dataset.tab));
  }));
  ["patientMode", "lensMode", "prescriptionMode", "coatingMode"].forEach((name) => form.elements[name].addEventListener("change", toggleConditionalFields));
  form.elements.lensCatalog.addEventListener("change", syncLensOptions);
  $("#previewRx").addEventListener("click", () => run(preview));
  $("#stageRx").addEventListener("click", () => run(stage));
  $("#downloadRx").addEventListener("click", () => run(download));
  $("#releaseRx").addEventListener("click", () => run(release));
  toggleConditionalFields();
  load();
})();
