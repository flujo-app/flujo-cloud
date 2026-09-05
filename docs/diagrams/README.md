# Diagram sources

`deployment.mmd` is the editable Mermaid source; `deployment.svg` is its committed rendered output, embedded in the [architecture guide](../architecture.md). The sequence diagram is maintained directly in that guide's Mermaid block.

The deployment diagram groups three independent app/Machine/volume deployments. An arrow to the group describes the same operation on each worker; there is no shared worker gateway, load balancer or volume.

The SVG was rendered and visually checked with `@mermaid-js/mermaid-cli@11.17.0` (Mermaid 11.17.2). From the repository root, an optional development command is:

```text
npx --yes --package @mermaid-js/mermaid-cli@11.17.0 mmdc -i docs/diagrams/deployment.mmd -o docs/diagrams/deployment.svg -b white -w 2200 -H 1800
```

The renderer uses Chromium through Puppeteer. If using an existing compatible browser, pass `-p PATH_TO_PUPPETEER_CONFIG` with its `executablePath`. Rendering tools are documentation tooling only and are not bridge runtime dependencies.

After changes, render both diagrams, inspect label/arrow placement, check local Markdown links and run `git diff --check`. Commit the updated source and SVG together. Avoid putting workspace data or credential values in diagram labels.
