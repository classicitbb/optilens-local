# OptiLens Local Design System

## Status

Implemented locally — browser verification of authenticated modules requires an authorized external browser session.

## Foundation

`public/styles/tokens.css` is the shared source for the Classic Visions-compatible palette and semantic product tokens. New styles should use semantic values such as `--color-surface`, `--color-text`, `--color-interactive`, and `--color-accent`; legacy aliases remain temporarily so existing workflows continue unchanged.

`public/styles/system.css` is loaded after each page's layout stylesheet. It owns visual primitives and shared responsive/accessibility behaviour:

- Plus Jakarta Sans type hierarchy and precision labels.
- Panels, cards, badges, buttons, fields, tables, tabs, and app workspace framing.
- Light and dark semantic token mappings, teal focus rings, and reduced-motion support.
- A compact operational density suitable for delivery, pricing, metrics, and administrative work.

## Page boundary

Page CSS composes layouts only. It must not create a new button, badge, card, form-control, tab, dialog, or palette treatment. Add or extend the shared primitive in `public/styles/system.css` instead.

The statement template is deliberately a printable-document exception: it loads the common token file and system stylesheet for typography and brand values, but does not inherit the application shell.

## Verification

Run:

```powershell
node --test test/design-system.test.js
npm run check
git diff --check
```

The design-system test asserts that every current application surface loads the final system stylesheet, the printable statement receives common tokens, semantic foundation tokens remain available, and capability icons do not regress to embedded palette colours.

## Remaining browser acceptance

Use an authorized external Chrome or Edge session to inspect Dashboard, Delivery Export, Pricing Automation, Business Metrics, Automation, Integrations, Credentials, Settings, Users, Supplier Email, Release Notes, and the statement print view in both light and dark modes. Confirm keyboard focus, dense-table readability, no horizontal page overflow, and unchanged workflow actions before deployment.
