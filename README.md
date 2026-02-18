# Digma

MCP server bridging AI editors to Figma for chat-driven design. Runs entirely locally — no external services, no Figma Community installs required.

```
AI Editor --> MCP (stdio) --> Digma Server --> WebSocket (localhost) --> Digma Plugin --> Canvas
```

## How It Works

Digma runs two things in one process:

1. **MCP server** on stdio — your AI editor (Cursor, Claude Code, etc.) calls design tools through this
2. **WebSocket server** on localhost:3055 — the Digma Figma plugin connects here to receive commands and execute them on the canvas

All communication stays on your machine. Nothing is sent externally.

## Prerequisites

- Node.js 18+
- Figma desktop or web app

## Setup

### 1. Build the server

```sh
cd digma
pnpm install
pnpm run build
```

### 2. Load the Digma plugin in Figma

No community install needed. Load it locally in Figma:

1. Open Figma desktop
2. Go to **Plugins > Development > Import plugin from manifest...**
3. Select your Digma plugin's `manifest.json`
4. The plugin is now available under **Plugins > Development > Digma**

For the web app, use **Plugins > Development > Import plugin from manifest** and point to the plugin directory.

### 3. Add to your AI editor

**Cursor** — edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "digma": {
      "command": "node",
      "args": ["digma/dist/server.js"]
    }
  }
}
```

**Claude Code** — edit `~/.claude/settings.json` or project `.mcp.json`:

```json
{
  "mcpServers": {
    "digma": {
      "command": "node",
      "args": ["digma/dist/server.js"]
    }
  }
}
```

### 4. Connect and design

1. Open a Figma file
2. Run the Digma plugin (Plugins > Development > Digma)
3. The plugin connects to the local WebSocket server automatically
4. Chat in your AI editor — designs appear on the canvas in real-time

## Configuration

| Variable              | Default      | Description                     |
| --------------------- | ------------ | ------------------------------- |
| `DIGMA_PORT`          | `3055`       | WebSocket server port           |
| `DIGMA_HOST`          | `127.0.0.1`  | WebSocket bind address          |
| `DIGMA_HANDSHAKE_KEY` | _(built-in)_ | Override the HMAC handshake key |

Pass environment variables in your MCP config:

```json
{
  "mcpServers": {
    "digma": {
      "command": "node",
      "args": ["digma/dist/server.js"],
      "env": {
        "DIGMA_PORT": "4000"
      }
    }
  }
}
```

## Available Tools

### Canvas Creation

| Tool               | Description                              |
| ------------------ | ---------------------------------------- |
| `create_frame`     | Create frames (screens, sections, cards) |
| `create_text`      | Add text with font, size, weight, color  |
| `create_rectangle` | Create rectangles and shapes             |
| `create_ellipse`   | Create circles and ovals                 |
| `create_line`      | Create lines and dividers                |
| `create_svg_node`  | Create icons and vectors from SVG markup |

### Layout & Styling

| Tool              | Description                                    |
| ----------------- | ---------------------------------------------- |
| `set_auto_layout` | Configure flexbox-style auto-layout on a frame |
| `modify_node`     | Edit any existing element's properties         |
| `set_stroke`      | Add borders and strokes                        |
| `set_effects`     | Add shadows and blur effects                   |

### Inspection & Navigation

| Tool                    | Description                            |
| ----------------------- | -------------------------------------- |
| `get_connection_status` | Check if the Digma plugin is connected |
| `get_selection`         | Read the current selection             |
| `get_page_structure`    | Get the full page tree                 |
| `read_node_properties`  | Inspect any node's properties          |
| `find_nodes`            | Search for elements by name or type    |
| `set_selection`         | Select and zoom to elements            |

### Structure

| Tool             | Description                     |
| ---------------- | ------------------------------- |
| `delete_node`    | Remove elements                 |
| `move_to_parent` | Restructure the layer hierarchy |

### Components & Design System

| Tool                        | Description                   |
| --------------------------- | ----------------------------- |
| `get_local_styles`          | Read the file's design tokens |
| `list_components`           | Browse available components   |
| `create_component_instance` | Use existing components       |
| `detach_instance`           | Convert instances to frames   |

### Library

| Tool                        | Description                       |
| --------------------------- | --------------------------------- |
| `get_library_info`          | View connected library info       |
| `search_library_components` | Search across your design system  |
| `create_library_instance`   | Import and use library components |

Library tools require scanning via the Digma plugin UI (Design System Library section > enter Figma access token and library file key > Scan Library).

## Example Prompts

```
"Create a mobile login screen with email and password fields"
"Design a dashboard with a sidebar, KPI cards, and charts"
"Edit the selected frame — make the button rounded and change the color to blue"
"List all components named 'button' and create an instance of the primary variant"
```

## Development

```sh
npm run dev    # build and start
npm run build  # compile TypeScript only
npm start      # run compiled server
```

## WebSocket Protocol

The Digma plugin authenticates via HMAC-SHA256 challenge-response:

1. Server sends `{ type: "handshake_challenge", nonce: "<random>" }`
2. Plugin responds with `{ type: "handshake_response", hash: HMAC-SHA256(key, nonce) }`
3. Server validates and sends `{ type: "handshake_ok" }`

After authentication, the plugin receives commands as `{ id, command, params }` and responds with `{ id, result }` or `{ id, type: "error", error }`.

## Security

- WebSocket binds to `127.0.0.1` only — no network exposure
- HMAC handshake key configurable via `DIGMA_HANDSHAKE_KEY`
- No filesystem access, no outbound network calls, no telemetry
- No `eval()` or dynamic code execution

## License

MIT
