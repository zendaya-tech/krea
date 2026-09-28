# Krea

Krea is a local editor for 2D tile maps and 3D terrain maps for video games. A project is one `.krea` file containing maps, objects, sprites, textures, 3D models, collisions, and terrain data. The same project can be edited visually or through a stateless HTTP API for an AI agent.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal. The API normally runs on `http://localhost:3001`. For a built release:

```bash
npm run build
node dist/cli.js start --no-open
```

`node dist/cli.js --help` lists the CLI commands. `npm run typecheck` checks the TypeScript source.

After the npm package is published, run it without installing globally:

```bash
npx krea start
npx krea start path/to/world.krea --port 3001
npx krea skill install --agent codex
```

`npx krea --help` lists the CLI options. The first command starts the local editor and opens it in your browser. `npm install -g krea` also provides the `krea` command.

## Editor

- Create or open a `.krea` project. Recently opened projects appear on the opening screen and can be removed from that list.
- Build 2D maps with tiled objects and sprite collisions.
- Sculpt and paint 3D terrain, add water, and place 2D billboards or GLB models.
- Add grass, flowers, and other vegetation as catalog objects. With the 3D **Place** tool, choose one placement or scatter within a circle and set count, radius, spacing, slope, and water behavior.
- In **Add Object → 3D**, use **Create** beside Import to open the model editor. Start with a blank shape, a person, or a face; add, duplicate, or remove primitive parts; move, rotate, scale, and color them in the 3D view. Krea stores a generated GLB and its editable source in the project, so the model can be opened again by editing that object. Imported GLBs are also stored in the project.
- Export a map for a game engine or unpack a project to inspect its files.

## Agent API

The API is documented at `GET /api/agent/openapi.json`. Each agent request supplies an absolute `projectPath` and operates on that `.krea` file without changing the editor's current session. The [Krea skill](skills/krea/SKILL.md) and [API reference](skills/krea/references/api.md) contain examples.

| Task | Endpoint |
| --- | --- |
| Create, read, or replace a project | `POST`, `GET`, `PUT /api/agent/project` |
| Apply a validated batch of map edits | `POST /api/agent/operations` |
| Discover operations and parameters | `GET /api/agent/operations` |
| Upload or list project images and GLBs | `POST`, `GET /api/agent/assets` |
| Create or update an editable 3D model | `POST /api/agent/models` |
| List models or get starter templates | `GET /api/agent/models`, `GET /api/agent/model-templates` |
| Inspect maps, objects, terrain, or summaries | `GET /api/agent/maps`, `/objects`, `/terrain`, `/summary` |
| Export or unpack a project | `POST /api/agent/export`, `/unpack` |

For example, `POST /api/agent/models` with `{ "projectPath": "/games/world.krea", "name": "Guard", "template": "person" }` creates a catalog object and saves its GLB plus the 14 editable parts. Send its `objectId` and an edited `source` to revise it later. `scatterObjects3D` accepts `circle: { x, z, radius }` for local vegetation scatter.

## Project format

The `.krea` file is a ZIP archive with `project.json`, `assets/` and map data. Use the editor or API to write it. See the [format reference](skills/krea/references/project-format.md) for details.

Krea is released under the [MIT license](LICENSE).

## CI and npm releases

GitHub Actions builds on Node 20 and 24. A `vX.Y.Z` tag runs the publish workflow only when it exactly matches `package.json` and the configured GitHub repository. It builds the editor, checks the npm package contents and CLI, then publishes to npm with provenance. The package includes the CLI, built editor and AI skill; source and development dependencies are excluded. See [release instructions](docs/releasing.md) for the first publish and the npm trusted publisher setup.
