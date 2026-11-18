import {Button, Card, Chip, Input, Label, TextArea} from "@heroui/react";
import {flushSync} from "react-dom";
import {createRoot} from "react-dom/client";

const rootElement = document.getElementById("popup");
const beta = rootElement.hasAttribute("data-beta");
const defaultUrl = getServerUrl(chrome.runtime.getManifest());

function getServerUrl(manifest) {
  const target = manifest.host_permissions?.find((pattern) =>
    /^http:\/\/(?:\d+\.){3}\d+:\d+\/\*$/.test(pattern) && !pattern.startsWith("http://127."));
  return target?.replace(/\/\*$/, "") ?? "";
}

function Field({id, label, children, ...props}) {
  return (
    <div className="popup-field">
      <Label htmlFor={id}>{label}</Label>
      {children || <Input id={id} fullWidth {...props} />}
    </div>
  );
}

function Popup() {
  return (
    <main>
      <Card className="popup-card" aria-labelledby="popup-title">
        <Card.Header className="popup-heading">
          <div className="popup-heading-copy">
            <p className="popup-brand">OptiLens Local</p>
            <h1 id="popup-title">BeSwift CO</h1>
          </div>
          {beta && (
            <div className="popup-edition">
              <Chip size="sm" color="warning" variant="soft">Beta</Chip>
              <span id="version" />
            </div>
          )}
        </Card.Header>
        <Card.Content className="popup-content">
          <form id="claimForm" className="popup-workflow">
            <Field id="baseUrl" label="OptiLens URL" inputMode="url" defaultValue={defaultUrl} />
            <Field id="claimCode" label="Claim code" autoComplete="off" />
            <Button id="startBtn" type="submit" fullWidth>Claim and fill</Button>
          </form>
          {beta && (
            <div className="popup-preferences">
              <label className="popup-option">
                <input id="autoDrive" type="checkbox" />
                <span>Auto-drive queued jobs</span>
              </label>
              <Field id="fillSpeed" label="Fill speed">
                <select id="fillSpeed" className="input input--full-width">
                  <option value="1">1× · Original pacing</option>
                  <option value="2">2× · Default</option>
                  <option value="3">3×</option>
                  <option value="4">4×</option>
                </select>
              </Field>
            </div>
          )}
          <p id="status" role="status" />
          <section id="jobPanel" aria-label="Current job" hidden>
            <p id="jobStatusLine" role="status" />
            {beta && (
              <fieldset id="resolutionBox" hidden>
                <legend>Record the fix (optional)</legend>
                <Field id="resField" label="Field" autoComplete="off" />
                <Field id="resExpected" label="Expected" autoComplete="off" />
                <Field id="resActual" label="Actually had" autoComplete="off" />
                <Field id="resFix" label="What you did"><TextArea id="resFix" rows={2} fullWidth /></Field>
                <Field id="resNote" label="Notes / root cause"><TextArea id="resNote" rows={2} fullWidth /></Field>
              </fieldset>
            )}
            <Button id="resumeBtn" variant="secondary" type="button" fullWidth hidden>
              {beta ? "Save fix & Resume" : "Resume"}
            </Button>
            <ol id="jobLog" />
          </section>
        </Card.Content>
      </Card>
    </main>
  );
}

// The existing popup controller runs next and binds to these DOM controls.
const root = createRoot(rootElement);
flushSync(() => root.render(<Popup />));
