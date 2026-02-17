#!/usr/bin/env node
/**
 * Digma — Figma <> AI MCP Server
 *
 * This server does two things:
 * 1. Runs an MCP server (over stdio) so AI editors can call design tools
 * 2. Runs a WebSocket server so the Digma Figma plugin can connect and receive commands
 *
 * Flow: AI Editor -> MCP tool call -> WebSocket -> Digma Plugin -> design created
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { randomUUID, createHmac, randomBytes } from "crypto";

// ─── Logging (stderr only — stdout is reserved for MCP protocol) ────────────

const log = (...args: unknown[]) =>
  console.error(`[digma ${new Date().toISOString()}]`, ...args);

// ─── Configuration ──────────────────────────────────────────────────────────

const WS_PORT = Number(process.env.DIGMA_PORT) || 3055;
const WS_HOST = process.env.DIGMA_HOST || "127.0.0.1"; // SECURITY: localhost only
const COMMAND_TIMEOUT_MS = 30_000;

// ─── Handshake Key ──────────────────────────────────────────────────────────
// Default key for compatibility with the Figma plugin.
// Override via DIGMA_HANDSHAKE_KEY for additional security.
const DEFAULT_HANDSHAKE_KEY = "fgsr7x9KmQ3pWv2RnL8jHt5YcD4sbA6e";
const HANDSHAKE_KEY = process.env.DIGMA_HANDSHAKE_KEY || DEFAULT_HANDSHAKE_KEY;

// ─── Types ──────────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface LibraryComponent {
  name: string;
  description: string;
  componentSetName?: string;
  containingFrame?: string;
  [key: string]: unknown;
}

interface LibraryStyle {
  [key: string]: unknown;
}

interface LibraryCatalog {
  fileKey: string;
  fileName: string;
  components: LibraryComponent[];
  styles: LibraryStyle[];
  scannedAt: string;
}

// ─── Bridge ─────────────────────────────────────────────────────────────────

class DigmaBridge {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private wss: WebSocketServer;
  private authenticated = false;
  public onCatalogUpdate?: (catalog: LibraryCatalog) => void;

  constructor(port: number, host: string) {
    this.wss = new WebSocketServer({ port, host });
    log(`WebSocket server listening on ${host}:${port}`);

    this.wss.on("connection", (ws) => {
      log("New WebSocket connection — starting handshake...");

      // Generate a random nonce for this connection
      const nonce = randomBytes(32).toString("hex");
      let handshakeComplete = false;

      // Send nonce challenge
      ws.send(JSON.stringify({ type: "handshake_challenge", nonce }));

      // Set a handshake timeout — must authenticate within 5s
      const handshakeTimeout = setTimeout(() => {
        if (!handshakeComplete) {
          log("Handshake timeout — closing connection");
          ws.close(4001, "Handshake timeout");
        }
      }, 5000);

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());

          // ── Handshake verification ──
          if (!handshakeComplete) {
            if (msg.type === "handshake_response" && msg.hash) {
              const expected = createHmac("sha256", HANDSHAKE_KEY)
                .update(nonce)
                .digest("hex");
              if (msg.hash === expected) {
                handshakeComplete = true;
                this.authenticated = true;
                clearTimeout(handshakeTimeout);

                // Close any previous connection
                if (
                  this.ws &&
                  this.ws !== ws &&
                  this.ws.readyState === WebSocket.OPEN
                ) {
                  this.ws.close();
                }
                this.ws = ws;

                ws.send(JSON.stringify({ type: "handshake_ok" }));
                log("Digma plugin authenticated");
              } else {
                log("Handshake failed — invalid hash");
                ws.close(4003, "Invalid handshake");
              }
            } else {
              // Not a handshake message before auth — reject
              ws.send(
                JSON.stringify({ type: "error", error: "Handshake required" }),
              );
            }
            return;
          }

          // ── Authenticated messages ──

          // Handle catalog push from plugin UI
          if (msg.type === "catalog_update" && msg.catalog) {
            this.onCatalogUpdate?.(msg.catalog);
            return;
          }

          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(msg.id);
            if (msg.type === "error") {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve(msg.result);
            }
          }
        } catch (e) {
          log("Error parsing WebSocket message:", e);
        }
      });

      ws.on("close", () => {
        clearTimeout(handshakeTimeout);
        if (this.ws === ws) {
          log("Digma plugin disconnected");
          this.ws = null;
          this.authenticated = false;
          // Reject all pending requests
          for (const [, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("Digma plugin disconnected"));
          }
          this.pendingRequests.clear();
        }
      });

      ws.on("error", (err) => {
        log("WebSocket error:", err.message);
      });
    });
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async sendCommand(
    command: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.isConnected) {
      throw new Error(
        "Digma plugin is not connected. Please open Figma and run the Digma plugin first.",
      );
    }

    const id = randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `Command '${command}' timed out after ${COMMAND_TIMEOUT_MS}ms`,
          ),
        );
      }, COMMAND_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.ws!.send(JSON.stringify({ id, command, params }));
    });
  }
}

// ─── Library Scanner ────────────────────────────────────────────────────────

class FigmaLibraryScanner {
  private catalogs = new Map<string, LibraryCatalog>();

  /** Called when the plugin UI pushes a scanned catalog */
  setCatalog(catalog: LibraryCatalog): void {
    this.catalogs.set(catalog.fileKey, catalog);
  }

  getCatalog(fileKey: string): LibraryCatalog | undefined {
    return this.catalogs.get(fileKey);
  }

  getAllCatalogs(): LibraryCatalog[] {
    return Array.from(this.catalogs.values());
  }

  hasAnyCatalog(): boolean {
    return this.catalogs.size > 0;
  }

  searchComponents(query: string): LibraryComponent[] {
    const q = query.toLowerCase();
    const results: LibraryComponent[] = [];
    for (const catalog of this.catalogs.values()) {
      for (const comp of catalog.components) {
        if (
          comp.name.toLowerCase().includes(q) ||
          comp.description.toLowerCase().includes(q) ||
          (comp.componentSetName &&
            comp.componentSetName.toLowerCase().includes(q)) ||
          (comp.containingFrame &&
            comp.containingFrame.toLowerCase().includes(q))
        ) {
          results.push(comp);
        }
      }
    }
    return results;
  }

  getAllComponents(): LibraryComponent[] {
    const results: LibraryComponent[] = [];
    for (const catalog of this.catalogs.values()) {
      results.push(...catalog.components);
    }
    return results;
  }

  getAllStyles(): LibraryStyle[] {
    const results: LibraryStyle[] = [];
    for (const catalog of this.catalogs.values()) {
      results.push(...catalog.styles);
    }
    return results;
  }
}

// ─── Create instances ───────────────────────────────────────────────────────

const bridge = new DigmaBridge(WS_PORT, WS_HOST);
const libraryScanner = new FigmaLibraryScanner();

// When plugin UI pushes a catalog, store it
bridge.onCatalogUpdate = (catalog: LibraryCatalog) => {
  libraryScanner.setCatalog(catalog);
  log(
    `Received library catalog: "${catalog.fileName}" — ${catalog.components.length} components, ${catalog.styles.length} styles`,
  );
};

const server = new McpServer({
  name: "digma",
  version: "1.0.0",
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function ok(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

function err(error: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${error}` }],
    isError: true,
  };
}

async function run(command: string, params: Record<string, unknown>) {
  try {
    const result = await bridge.sendCommand(command, params);
    return ok(result);
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ─── MCP Tools ──────────────────────────────────────────────────────────────

// 1. Connection status
server.tool(
  "get_connection_status",
  "Check if the Digma plugin is currently connected to this bridge server",
  {},
  async () => ok({ connected: bridge.isConnected }),
);

// 2. Create Frame
server.tool(
  "create_frame",
  `Create a new frame in Figma. Frames are the primary container/layout element (like a div in HTML). Use them for screens, sections, cards, navigation bars, buttons, etc. Returns the new frame's node ID for use in subsequent operations.`,
  {
    name: z
      .string()
      .optional()
      .describe("Name of the frame (e.g. 'Login Screen', 'Nav Bar')"),
    x: z.number().optional().describe("X position in pixels (default: 0)"),
    y: z.number().optional().describe("Y position in pixels (default: 0)"),
    width: z.number().optional().describe("Width in pixels (default: 100)"),
    height: z.number().optional().describe("Height in pixels (default: 100)"),
    fillColor: z
      .string()
      .optional()
      .describe(
        "Fill color as hex string e.g. '#FFFFFF', '#1A1A2E', '#FF000080' (with alpha)",
      ),
    cornerRadius: z.number().optional().describe("Corner radius in pixels"),
    parentId: z
      .string()
      .optional()
      .describe(
        "ID of a parent frame to nest this inside. Omit to place on the canvas root.",
      ),
  },
  async (params) => run("create_frame", params),
);

// 3. Create Rectangle
server.tool(
  "create_rectangle",
  "Create a rectangle shape. Useful for backgrounds, dividers, decorative elements, image placeholders, etc.",
  {
    name: z.string().optional().describe("Name of the rectangle"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    width: z.number().optional().describe("Width in pixels (default: 100)"),
    height: z.number().optional().describe("Height in pixels (default: 100)"),
    fillColor: z
      .string()
      .optional()
      .describe("Fill color as hex e.g. '#E2E8F0'"),
    cornerRadius: z.number().optional().describe("Corner radius"),
    parentId: z.string().optional().describe("Parent frame ID to place inside"),
  },
  async (params) => run("create_rectangle", params),
);

// 4. Create Ellipse
server.tool(
  "create_ellipse",
  "Create an ellipse (circle or oval). Useful for avatars, status indicators, decorative elements. Set equal width/height for a perfect circle.",
  {
    name: z.string().optional().describe("Name of the ellipse"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    width: z.number().optional().describe("Width in pixels (default: 100)"),
    height: z.number().optional().describe("Height in pixels (default: 100)"),
    fillColor: z.string().optional().describe("Fill color as hex"),
    parentId: z.string().optional().describe("Parent frame ID"),
  },
  async (params) => run("create_ellipse", params),
);

// 5. Create Text
server.tool(
  "create_text",
  "Create a text element. Supports font family, size, weight (via fontStyle), color, and text wrapping.",
  {
    text: z.string().describe("The text content to display"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    fontSize: z
      .number()
      .optional()
      .describe("Font size in pixels (default: 14)"),
    fontFamily: z
      .string()
      .optional()
      .describe(
        "Font family name (default: 'Inter'). Must be available in the Figma file.",
      ),
    fontStyle: z
      .string()
      .optional()
      .describe(
        "Font style e.g. 'Regular', 'Bold', 'Semi Bold', 'Medium', 'Light' (default: 'Regular')",
      ),
    fillColor: z
      .string()
      .optional()
      .describe("Text color as hex e.g. '#1A1A2E'"),
    width: z
      .number()
      .optional()
      .describe("Fixed width for text wrapping. Omit for auto-width."),
    letterSpacing: z.number().optional().describe("Letter spacing in pixels"),
    lineHeight: z.number().optional().describe("Line height in pixels"),
    textAlignHorizontal: z
      .enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"])
      .optional()
      .describe("Horizontal text alignment"),
    parentId: z.string().optional().describe("Parent frame ID"),
  },
  async (params) => run("create_text", params),
);

// 6. Create Line
server.tool(
  "create_line",
  "Create a line element. Useful for dividers, separators, and decorative lines.",
  {
    name: z.string().optional().describe("Name of the line"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    length: z
      .number()
      .optional()
      .describe("Length of the line in pixels (default: 100)"),
    color: z
      .string()
      .optional()
      .describe("Line color as hex (default: '#000000')"),
    strokeWeight: z
      .number()
      .optional()
      .describe("Line thickness in pixels (default: 1)"),
    rotation: z
      .number()
      .optional()
      .describe("Rotation in degrees (0 = horizontal, 90 = vertical)"),
    parentId: z.string().optional().describe("Parent frame ID"),
  },
  async (params) => run("create_line", params),
);

// 7. Create SVG Node
server.tool(
  "create_svg_node",
  "Create a node from an SVG string. Great for icons, logos, and vector illustrations.",
  {
    svg: z.string().describe("Valid SVG markup string"),
    name: z.string().optional().describe("Name for the created node"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    width: z.number().optional().describe("Scale to this width"),
    height: z.number().optional().describe("Scale to this height"),
    parentId: z.string().optional().describe("Parent frame ID"),
  },
  async (params) => run("create_svg_node", params),
);

// 8. Set Auto Layout
server.tool(
  "set_auto_layout",
  `Configure auto-layout on a frame (Figma's equivalent of CSS Flexbox). This controls how children are arranged and spaced within the frame. Set direction, spacing, padding, and alignment.`,
  {
    nodeId: z.string().describe("ID of the frame to configure"),
    direction: z
      .enum(["HORIZONTAL", "VERTICAL"])
      .optional()
      .describe(
        "Layout direction — HORIZONTAL (row) or VERTICAL (column). Default: VERTICAL",
      ),
    spacing: z
      .number()
      .optional()
      .describe("Gap between child items in pixels"),
    padding: z
      .number()
      .optional()
      .describe(
        "Uniform padding on all sides (shorthand). Overrides individual paddings.",
      ),
    paddingTop: z.number().optional().describe("Top padding"),
    paddingRight: z.number().optional().describe("Right padding"),
    paddingBottom: z.number().optional().describe("Bottom padding"),
    paddingLeft: z.number().optional().describe("Left padding"),
    primaryAxisAlignItems: z
      .enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"])
      .optional()
      .describe("Alignment along the main axis (like justify-content)"),
    counterAxisAlignItems: z
      .enum(["MIN", "CENTER", "MAX"])
      .optional()
      .describe("Alignment along the cross axis (like align-items)"),
    primaryAxisSizingMode: z
      .enum(["FIXED", "AUTO"])
      .optional()
      .describe("FIXED = fixed size along main axis, AUTO = hug contents"),
    counterAxisSizingMode: z
      .enum(["FIXED", "AUTO"])
      .optional()
      .describe("FIXED = fixed size along cross axis, AUTO = hug contents"),
  },
  async (params) => run("set_auto_layout", params),
);

// 9. Modify Node
server.tool(
  "modify_node",
  `Modify properties of an existing node. Works on any node type. For text nodes, you can also update characters and fontSize. For auto-layout children, you can set layoutSizingHorizontal/layoutSizingVertical to control how they fill space.`,
  {
    nodeId: z.string().describe("ID of the node to modify"),
    x: z.number().optional().describe("New X position"),
    y: z.number().optional().describe("New Y position"),
    width: z.number().optional().describe("New width"),
    height: z.number().optional().describe("New height"),
    name: z.string().optional().describe("New name"),
    fillColor: z.string().optional().describe("New fill color as hex"),
    opacity: z.number().optional().describe("Opacity 0-1"),
    cornerRadius: z.number().optional().describe("Corner radius"),
    visible: z.boolean().optional().describe("Visibility"),
    rotation: z.number().optional().describe("Rotation in degrees"),
    // Text-specific
    characters: z.string().optional().describe("(Text nodes) New text content"),
    fontSize: z.number().optional().describe("(Text nodes) New font size"),
    textAlignHorizontal: z
      .enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"])
      .optional()
      .describe("(Text nodes) Horizontal alignment"),
    // Auto-layout child properties
    layoutSizingHorizontal: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("How this node sizes horizontally in auto-layout parent"),
    layoutSizingVertical: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("How this node sizes vertically in auto-layout parent"),
    layoutAlign: z
      .enum(["INHERIT", "STRETCH", "MIN", "CENTER", "MAX"])
      .optional()
      .describe("Cross-axis alignment override within auto-layout parent"),
    layoutGrow: z
      .number()
      .optional()
      .describe("Flex grow factor (0 = fixed, 1 = fill remaining space)"),
  },
  async (params) => run("modify_node", params),
);

// 10. Set Stroke
server.tool(
  "set_stroke",
  "Add or modify the stroke (border) on a node.",
  {
    nodeId: z.string().describe("ID of the node"),
    color: z
      .string()
      .optional()
      .describe("Stroke color as hex (default: '#000000')"),
    weight: z
      .number()
      .optional()
      .describe("Stroke weight in pixels (default: 1)"),
    strokeAlign: z
      .enum(["INSIDE", "OUTSIDE", "CENTER"])
      .optional()
      .describe("Stroke alignment (default: INSIDE)"),
    dashPattern: z
      .array(z.number())
      .optional()
      .describe("Dash pattern e.g. [4, 4] for dashed line"),
  },
  async (params) => run("set_stroke", params),
);

// 11. Set Effects
server.tool(
  "set_effects",
  "Apply visual effects (drop shadow, inner shadow, layer blur, background blur) to a node. Replaces existing effects.",
  {
    nodeId: z.string().describe("ID of the node"),
    effects: z
      .array(
        z.object({
          type: z
            .enum([
              "DROP_SHADOW",
              "INNER_SHADOW",
              "LAYER_BLUR",
              "BACKGROUND_BLUR",
            ])
            .describe("Effect type"),
          color: z
            .string()
            .optional()
            .describe(
              "Shadow color as hex with alpha e.g. '#00000040' (shadows only)",
            ),
          offsetX: z
            .number()
            .optional()
            .describe("Horizontal shadow offset (shadows only)"),
          offsetY: z
            .number()
            .optional()
            .describe("Vertical shadow offset (shadows only)"),
          radius: z.number().optional().describe("Blur radius in pixels"),
          spread: z
            .number()
            .optional()
            .describe("Shadow spread (shadows only)"),
        }),
      )
      .describe("Array of effects to apply"),
  },
  async (params) => run("set_effects", params),
);

// 12. Delete Node
server.tool(
  "delete_node",
  "Delete a node from the Figma document.",
  {
    nodeId: z.string().describe("ID of the node to delete"),
  },
  async (params) => run("delete_node", params),
);

// 13. Get Selection
server.tool(
  "get_selection",
  "Get information about the currently selected nodes in Figma. Useful for understanding what the user is looking at or wants to modify.",
  {},
  async () => run("get_selection", {}),
);

// 14. Get Page Structure
server.tool(
  "get_page_structure",
  "Get the hierarchical structure of all nodes on the current Figma page. Returns node IDs, names, types, positions, sizes, and children. Use this to understand the current state of the design.",
  {
    maxDepth: z
      .number()
      .optional()
      .describe("Maximum depth of the tree to return (default: 4)"),
  },
  async (params) => run("get_page_structure", params),
);

// 15. Move to Parent
server.tool(
  "move_to_parent",
  "Move a node into a different parent frame. Use this to restructure the layer hierarchy.",
  {
    nodeId: z.string().describe("ID of the node to move"),
    parentId: z.string().describe("ID of the new parent frame"),
    index: z
      .number()
      .optional()
      .describe(
        "Position index within the parent's children (omit to append at end)",
      ),
  },
  async (params) => run("move_to_parent", params),
);

// 16. Read Node Properties
server.tool(
  "read_node_properties",
  "Get detailed properties of a specific node by ID, including its children. Use this to inspect a node before modifying it.",
  {
    nodeId: z.string().describe("ID of the node to inspect"),
    depth: z
      .number()
      .optional()
      .describe("How deep to traverse children (default: 2)"),
  },
  async (params) => run("read_node_properties", params),
);

// ─── Team Library Tools ─────────────────────────────────────────────────────

// 17. Get Library Info
server.tool(
  "get_library_info",
  `Get the currently loaded design system library catalog. The library is scanned by the user via the Digma plugin UI in Figma (they enter their token and file key there). If no library is loaded, ask the user to open the Digma plugin in Figma and click "Scan Library" in the Design System Library section.`,
  {},
  async () => {
    if (!libraryScanner.hasAnyCatalog()) {
      return err(
        "No design system library is loaded yet. Please open the Digma plugin in Figma, expand the 'Design System Library' section, enter your Figma access token and library file key, and click 'Scan Library'.",
      );
    }
    const catalogs = libraryScanner.getAllCatalogs();
    return ok(
      catalogs.map((c) => ({
        fileName: c.fileName,
        fileKey: c.fileKey,
        componentCount: c.components.length,
        styleCount: c.styles.length,
        components: c.components.slice(0, 200),
        styles: c.styles.slice(0, 100),
        scannedAt: c.scannedAt,
      })),
    );
  },
);

// 18. Search Library Components
server.tool(
  "search_library_components",
  `Search across all scanned libraries for components matching a query. Use scan_library first to load a design system. Returns component keys that can be used with create_library_instance.`,
  {
    query: z
      .string()
      .describe(
        "Search query — matches component name, description, set name, or containing frame",
      ),
  },
  async (params) => {
    const results = libraryScanner.searchComponents(params.query);
    return ok({
      count: results.length,
      components: results.slice(0, 50),
    });
  },
);

// 19. Create Library Instance
server.tool(
  "create_library_instance",
  `Import a component from an enabled team library and create an instance of it. Use scan_library first to discover components, then use the component key from the results. The library must be enabled in the Figma file (Assets > Libraries).`,
  {
    key: z
      .string()
      .describe(
        "Component key from scan_library or search_library_components results",
      ),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    width: z.number().optional().describe("Override width"),
    height: z.number().optional().describe("Override height"),
    name: z.string().optional().describe("Custom instance name"),
    parentId: z.string().optional().describe("Parent frame ID to place inside"),
    variantName: z
      .string()
      .optional()
      .describe("For component sets: name of the specific variant to use"),
  },
  async (params) => run("import_component_by_key", params),
);

// ─── Design System Tools ────────────────────────────────────────────────────

// 20. List Components
server.tool(
  "list_components",
  `List all components and component sets in the Figma file. Returns component IDs, names, descriptions, and variant info. Use this to discover available design system components before creating designs. When a design system is available, ALWAYS prefer creating instances of existing components over building from scratch.`,
  {
    nameFilter: z
      .string()
      .optional()
      .describe(
        "Filter components by name (case-insensitive partial match). E.g. 'button', 'card', 'input'",
      ),
    pageOnly: z
      .boolean()
      .optional()
      .describe(
        "If true, only search the current page. If false/omitted, search the entire file.",
      ),
    limit: z
      .number()
      .optional()
      .describe("Max results to return (default: 100)"),
  },
  async (params) => run("list_components", params),
);

// 21. Create Component Instance
server.tool(
  "create_component_instance",
  `Create an instance of an existing component. Use list_components first to find available components and their IDs. For component sets (variants), use the specific variant's ID, not the set ID.`,
  {
    componentId: z
      .string()
      .describe("ID of the component to instantiate (from list_components)"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    width: z.number().optional().describe("Override width"),
    height: z.number().optional().describe("Override height"),
    name: z.string().optional().describe("Custom instance name"),
    parentId: z.string().optional().describe("Parent frame ID to place inside"),
  },
  async (params) => run("create_component_instance", params),
);

// 22. Detach Instance
server.tool(
  "detach_instance",
  "Detach a component instance, converting it into a regular frame. Useful when you need to customize an instance beyond its variant properties.",
  {
    nodeId: z.string().describe("ID of the component instance to detach"),
  },
  async (params) => run("detach_instance", params),
);

// 23. Get Local Styles
server.tool(
  "get_local_styles",
  `Get all local styles (colors, text styles, effect styles) defined in the Figma file. These represent the file's design tokens. Use these styles to maintain consistency when creating or editing designs.`,
  {},
  async () => run("get_local_styles", {}),
);

// ─── Search & Edit Tools ────────────────────────────────────────────────────

// 24. Find Nodes
server.tool(
  "find_nodes",
  `Search for nodes by name or type on the current page. Also searches text content for text nodes. Use this to find existing elements before editing them. For example, find all buttons, headers, or nodes matching a name pattern.`,
  {
    query: z
      .string()
      .optional()
      .describe(
        "Search query — matches against node names and text content (case-insensitive)",
      ),
    type: z
      .string()
      .optional()
      .describe(
        "Filter by node type: FRAME, TEXT, RECTANGLE, ELLIPSE, COMPONENT, INSTANCE, GROUP, etc.",
      ),
    rootNodeId: z
      .string()
      .optional()
      .describe(
        "Search within a specific subtree (node ID). Omit to search the entire current page.",
      ),
    limit: z.number().optional().describe("Max results (default: 50)"),
  },
  async (params) => run("find_nodes", params),
);

// 25. Set Selection
server.tool(
  "set_selection",
  "Select specific nodes in Figma and scroll the viewport to show them. Useful for highlighting elements for the user.",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to select"),
  },
  async (params) => run("set_selection", params),
);

// ─── Start ──────────────────────────────────────────────────────────────────

async function main() {
  log("Starting Digma...");
  log(`WebSocket server ready on ws://${WS_HOST}:${WS_PORT}`);
  log("Waiting for AI editor to connect via stdio MCP...");

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("MCP server connected — ready to receive tool calls");
}

main().catch((e) => {
  log("Fatal error:", e);
  process.exit(1);
});
