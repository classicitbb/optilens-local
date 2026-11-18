import {Button, Card, Input, Kbd} from "@heroui/react";
import {flushSync} from "react-dom";
import {createRoot} from "react-dom/client";

window.OptiLensUI = {
  mountSearchTrigger(button) {
    const mount = document.createElement("span");
    mount.className = "shell-search-mount";
    button.replaceWith(mount);
    const root = createRoot(mount);
    flushSync(() => {
      root.render(
        <Button
          id={button.id}
          type="button"
          className="search-bar"
          variant="outline"
          aria-label={button.getAttribute("aria-label")}
          aria-keyshortcuts="Control+K Meta+K"
          data-search-href={button.dataset.searchHref}
        >
          <span className="material-symbols-outlined" aria-hidden="true">search</span>
          <span className="sb-text">Search modules, wiki, settings…</span>
          <Kbd aria-hidden="true"><Kbd.Content>Ctrl+K</Kbd.Content></Kbd>
        </Button>
      );
    });
  },
  mountSearchPanel(mount) {
    const root = createRoot(mount);
    flushSync(() => {
      root.render(
        <Card variant="transparent" className="search-content-card">
          <Card.Header className="search-input-wrap">
            <span className="material-symbols-outlined" aria-hidden="true">search</span>
            <Input
              id="searchInput"
              type="search"
              className="search-input"
              aria-label="Search modules, settings and endpoints"
              placeholder="Search modules, settings, endpoints…"
              autoComplete="off"
              spellCheck={false}
            />
          </Card.Header>
          <Card.Content id="searchResults" className="search-results" />
        </Card>
      );
    });
  }
};
