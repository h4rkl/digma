// Digma — Figma Plugin Sandbox
// This file runs in Figma's plugin sandbox (no browser APIs).
// It receives commands from ui.html via postMessage and executes them on the Figma API.

figma.showUI(__html__, { width: 300, height: 480, themeColors: true });

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseHexColor(hex) {
  if (!hex) return null;
  hex = hex.replace('#', '');
  var a = 1;
  if (hex.length === 8) {
    a = parseInt(hex.slice(6, 8), 16) / 255;
    hex = hex.slice(0, 6);
  } else if (hex.length === 4) {
    a = parseInt(hex[3] + hex[3], 16) / 255;
    hex = hex.slice(0, 3);
  }
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  var r = parseInt(hex.slice(0, 2), 16) / 255;
  var g = parseInt(hex.slice(2, 4), 16) / 255;
  var b = parseInt(hex.slice(4, 6), 16) / 255;
  return { r: r, g: g, b: b, a: a };
}

function rgbToHex(r, g, b) {
  var toHex = function (c) {
    var h = Math.round(c * 255).toString(16);
    return h.length === 1 ? '0' + h : h;
  };
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

function setFillColor(node, hex) {
  var c = parseHexColor(hex);
  if (!c) return;
  var paint = { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
  node.fills = [paint];
}

function serializeNode(node, depth) {
  if (depth === undefined) depth = 2;
  var obj = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible
  };

  // Position and size
  if ('x' in node) obj.x = node.x;
  if ('y' in node) obj.y = node.y;
  if ('width' in node) obj.width = node.width;
  if ('height' in node) obj.height = node.height;
  if ('rotation' in node) obj.rotation = node.rotation;
  if ('opacity' in node) obj.opacity = node.opacity;

  // Fill color
  if ('fills' in node && node.fills && node.fills !== figma.mixed && node.fills.length > 0) {
    var fill = node.fills[0];
    if (fill.type === 'SOLID') {
      obj.fillColor = rgbToHex(fill.color.r, fill.color.g, fill.color.b);
      if (fill.opacity !== undefined && fill.opacity !== 1) obj.fillOpacity = fill.opacity;
    }
  }

  // Corner radius
  if ('cornerRadius' in node && node.cornerRadius !== figma.mixed) {
    obj.cornerRadius = node.cornerRadius;
  }

  // Text properties
  if (node.type === 'TEXT') {
    obj.characters = node.characters;
    if (node.fontSize !== figma.mixed) obj.fontSize = node.fontSize;
    if (node.fontName !== figma.mixed) obj.fontName = node.fontName;
    if (node.textAlignHorizontal) obj.textAlignHorizontal = node.textAlignHorizontal;
  }

  // Auto-layout
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    obj.layoutMode = node.layoutMode;
    obj.itemSpacing = node.itemSpacing;
    obj.paddingTop = node.paddingTop;
    obj.paddingRight = node.paddingRight;
    obj.paddingBottom = node.paddingBottom;
    obj.paddingLeft = node.paddingLeft;
    obj.primaryAxisAlignItems = node.primaryAxisAlignItems;
    obj.counterAxisAlignItems = node.counterAxisAlignItems;
    obj.primaryAxisSizingMode = node.primaryAxisSizingMode;
    obj.counterAxisSizingMode = node.counterAxisSizingMode;
  }

  // Auto-layout child properties
  if ('layoutSizingHorizontal' in node) obj.layoutSizingHorizontal = node.layoutSizingHorizontal;
  if ('layoutSizingVertical' in node) obj.layoutSizingVertical = node.layoutSizingVertical;
  if ('layoutAlign' in node) obj.layoutAlign = node.layoutAlign;
  if ('layoutGrow' in node) obj.layoutGrow = node.layoutGrow;

  // Strokes
  if ('strokes' in node && node.strokes && node.strokes.length > 0) {
    var stroke = node.strokes[0];
    if (stroke.type === 'SOLID') {
      obj.strokeColor = rgbToHex(stroke.color.r, stroke.color.g, stroke.color.b);
    }
    if ('strokeWeight' in node) obj.strokeWeight = node.strokeWeight;
    if ('strokeAlign' in node) obj.strokeAlign = node.strokeAlign;
  }

  // Component info
  if (node.type === 'COMPONENT') {
    obj.componentKey = node.key;
    obj.description = node.description;
  }
  if (node.type === 'COMPONENT_SET') {
    obj.componentKey = node.key;
    obj.description = node.description;
  }
  if (node.type === 'INSTANCE') {
    obj.componentId = node.mainComponent ? node.mainComponent.id : null;
  }

  // Children
  if ('children' in node && depth > 0) {
    obj.children = node.children.map(function (child) {
      return serializeNode(child, depth - 1);
    });
    obj.childCount = node.children.length;
  } else if ('children' in node) {
    obj.childCount = node.children.length;
  }

  return obj;
}

async function getParentNode(parentId) {
  if (!parentId) return figma.currentPage;
  var node = await figma.getNodeByIdAsync(parentId);
  if (!node) throw new Error('Parent node not found: ' + parentId);
  if (!('appendChild' in node)) throw new Error('Node ' + parentId + ' cannot have children');
  return node;
}

// ─── Command Handlers ───────────────────────────────────────────────────────

var handlers = {};

// --- Creation ---

handlers.create_frame = async function (params) {
  var parent = await getParentNode(params.parentId);
  var frame = figma.createFrame();
  frame.name = params.name || 'Frame';
  frame.x = params.x || 0;
  frame.y = params.y || 0;
  frame.resize(params.width || 100, params.height || 100);
  if (params.fillColor) {
    setFillColor(frame, params.fillColor);
  } else {
    // Figma defaults frames to white fill — clear it so layout containers are transparent
    frame.fills = [];
  }
  if (params.cornerRadius !== undefined) frame.cornerRadius = params.cornerRadius;
  if (params.clipsContent !== undefined) frame.clipsContent = params.clipsContent;
  parent.appendChild(frame);
  return { nodeId: frame.id, name: frame.name };
};

handlers.create_rectangle = async function (params) {
  var parent = await getParentNode(params.parentId);
  var rect = figma.createRectangle();
  rect.name = params.name || 'Rectangle';
  rect.x = params.x || 0;
  rect.y = params.y || 0;
  rect.resize(params.width || 100, params.height || 100);
  if (params.fillColor) setFillColor(rect, params.fillColor);
  if (params.cornerRadius !== undefined) rect.cornerRadius = params.cornerRadius;
  parent.appendChild(rect);
  return { nodeId: rect.id, name: rect.name };
};

handlers.create_ellipse = async function (params) {
  var parent = await getParentNode(params.parentId);
  var ellipse = figma.createEllipse();
  ellipse.name = params.name || 'Ellipse';
  ellipse.x = params.x || 0;
  ellipse.y = params.y || 0;
  ellipse.resize(params.width || 100, params.height || 100);
  if (params.fillColor) setFillColor(ellipse, params.fillColor);
  parent.appendChild(ellipse);
  return { nodeId: ellipse.id, name: ellipse.name };
};

handlers.create_text = async function (params) {
  var parent = await getParentNode(params.parentId);
  var text = figma.createText();
  var family = params.fontFamily || 'Inter';
  var style = params.fontStyle || 'Regular';
  try {
    await figma.loadFontAsync({ family: family, style: style });
  } catch (e) {
    // Fall back to Regular if the requested style isn't available
    style = 'Regular';
    await figma.loadFontAsync({ family: family, style: style });
  }
  text.fontName = { family: family, style: style };
  text.characters = params.text || '';
  text.name = params.text ? params.text.slice(0, 30) : 'Text';
  text.x = params.x || 0;
  text.y = params.y || 0;
  if (params.fontSize) text.fontSize = params.fontSize;
  if (params.fillColor) setFillColor(text, params.fillColor);
  if (params.width) {
    text.resize(params.width, text.height);
    text.textAutoResize = 'HEIGHT';
  }
  if (params.letterSpacing !== undefined) text.letterSpacing = { value: params.letterSpacing, unit: 'PIXELS' };
  if (params.lineHeight !== undefined) text.lineHeight = { value: params.lineHeight, unit: 'PIXELS' };
  if (params.textAlignHorizontal) text.textAlignHorizontal = params.textAlignHorizontal;
  parent.appendChild(text);
  return { nodeId: text.id, name: text.name };
};

handlers.create_line = async function (params) {
  var parent = await getParentNode(params.parentId);
  var line = figma.createLine();
  line.name = params.name || 'Line';
  line.x = params.x || 0;
  line.y = params.y || 0;
  line.resize(params.length || 100, 0);
  var color = parseHexColor(params.color || '#000000');
  if (color) {
    line.strokes = [{ type: 'SOLID', color: { r: color.r, g: color.g, b: color.b }, opacity: color.a }];
  }
  line.strokeWeight = params.strokeWeight || 1;
  if (params.rotation !== undefined) line.rotation = params.rotation;
  parent.appendChild(line);
  return { nodeId: line.id, name: line.name };
};

handlers.create_svg_node = async function (params) {
  var parent = await getParentNode(params.parentId);
  var svgNode = figma.createNodeFromSvg(params.svg);
  if (params.name) svgNode.name = params.name;
  svgNode.x = params.x || 0;
  svgNode.y = params.y || 0;
  if (params.width && params.height) {
    svgNode.resize(params.width, params.height);
  } else if (params.width) {
    var scale = params.width / svgNode.width;
    svgNode.resize(params.width, svgNode.height * scale);
  } else if (params.height) {
    var scale = params.height / svgNode.height;
    svgNode.resize(svgNode.width * scale, params.height);
  }
  parent.appendChild(svgNode);
  return { nodeId: svgNode.id, name: svgNode.name };
};

// --- Layout & Style ---

handlers.set_auto_layout = async function (params) {
  var node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) throw new Error('Node not found: ' + params.nodeId);
  if (!('layoutMode' in node)) throw new Error('Node does not support auto-layout');

  node.layoutMode = params.direction || 'VERTICAL';
  if (params.spacing !== undefined) node.itemSpacing = params.spacing;
  if (params.layoutWrap !== undefined) node.layoutWrap = params.layoutWrap;

  if (params.padding !== undefined) {
    node.paddingTop = params.padding;
    node.paddingRight = params.padding;
    node.paddingBottom = params.padding;
    node.paddingLeft = params.padding;
  }
  if (params.paddingTop !== undefined) node.paddingTop = params.paddingTop;
  if (params.paddingRight !== undefined) node.paddingRight = params.paddingRight;
  if (params.paddingBottom !== undefined) node.paddingBottom = params.paddingBottom;
  if (params.paddingLeft !== undefined) node.paddingLeft = params.paddingLeft;

  if (params.primaryAxisAlignItems) node.primaryAxisAlignItems = params.primaryAxisAlignItems;
  if (params.counterAxisAlignItems) node.counterAxisAlignItems = params.counterAxisAlignItems;
  if (params.primaryAxisSizingMode) node.primaryAxisSizingMode = params.primaryAxisSizingMode;
  if (params.counterAxisSizingMode) node.counterAxisSizingMode = params.counterAxisSizingMode;

  return { nodeId: node.id, layoutMode: node.layoutMode };
};

handlers.modify_node = async function (params) {
  var node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) throw new Error('Node not found: ' + params.nodeId);

  if (params.name !== undefined) node.name = params.name;
  if (params.visible !== undefined) node.visible = params.visible;
  if (params.x !== undefined && 'x' in node) node.x = params.x;
  if (params.y !== undefined && 'y' in node) node.y = params.y;
  if (params.rotation !== undefined && 'rotation' in node) node.rotation = params.rotation;
  if (params.opacity !== undefined && 'opacity' in node) node.opacity = params.opacity;

  if (params.width !== undefined && params.height !== undefined && 'resize' in node) {
    node.resize(params.width, params.height);
  } else if (params.width !== undefined && 'resize' in node) {
    node.resize(params.width, node.height);
  } else if (params.height !== undefined && 'resize' in node) {
    node.resize(node.width, params.height);
  }

  if (params.fillColor && 'fills' in node) setFillColor(node, params.fillColor);
  if (params.cornerRadius !== undefined && 'cornerRadius' in node) node.cornerRadius = params.cornerRadius;

  // Text-specific modifications
  if (node.type === 'TEXT') {
    // Load current font before making text changes
    var currentFont = node.fontName;
    if (currentFont !== figma.mixed) {
      await figma.loadFontAsync(currentFont);
    } else {
      // Mixed fonts — load all unique fonts used in the text
      var len = node.characters.length;
      var fonts = {};
      for (var i = 0; i < len; i++) {
        var f = node.getRangeFontName(i, i + 1);
        var key = f.family + '/' + f.style;
        if (!fonts[key]) {
          fonts[key] = f;
          await figma.loadFontAsync(f);
        }
      }
    }
    if (params.characters !== undefined) node.characters = params.characters;
    if (params.fontSize !== undefined) node.fontSize = params.fontSize;
    if (params.textAlignHorizontal) node.textAlignHorizontal = params.textAlignHorizontal;
  }

  // Auto-layout child properties
  if (params.layoutSizingHorizontal !== undefined && 'layoutSizingHorizontal' in node) {
    node.layoutSizingHorizontal = params.layoutSizingHorizontal;
  }
  if (params.layoutSizingVertical !== undefined && 'layoutSizingVertical' in node) {
    node.layoutSizingVertical = params.layoutSizingVertical;
  }
  if (params.layoutAlign !== undefined && 'layoutAlign' in node) {
    node.layoutAlign = params.layoutAlign;
  }
  if (params.layoutGrow !== undefined && 'layoutGrow' in node) {
    node.layoutGrow = params.layoutGrow;
  }

  return { nodeId: node.id, name: node.name };
};

handlers.set_stroke = async function (params) {
  var node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) throw new Error('Node not found: ' + params.nodeId);
  if (!('strokes' in node)) throw new Error('Node does not support strokes');

  var color = parseHexColor(params.color || '#000000');
  node.strokes = [{ type: 'SOLID', color: { r: color.r, g: color.g, b: color.b }, opacity: color.a }];
  node.strokeWeight = params.weight || 1;
  if (params.strokeAlign) node.strokeAlign = params.strokeAlign;
  if (params.dashPattern) node.dashPattern = params.dashPattern;

  return { nodeId: node.id };
};

handlers.set_effects = async function (params) {
  var node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) throw new Error('Node not found: ' + params.nodeId);
  if (!('effects' in node)) throw new Error('Node does not support effects');

  var effects = params.effects.map(function (e) {
    var effect = { type: e.type, visible: true };
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      var c = parseHexColor(e.color || '#00000040');
      effect.color = { r: c.r, g: c.g, b: c.b, a: c.a };
      effect.offset = { x: e.offsetX || 0, y: e.offsetY || 4 };
      effect.radius = e.radius || 4;
      effect.spread = e.spread || 0;
      effect.blendMode = 'NORMAL';
    } else {
      // LAYER_BLUR or BACKGROUND_BLUR
      effect.radius = e.radius || 4;
    }
    return effect;
  });
  node.effects = effects;

  return { nodeId: node.id, effectCount: effects.length };
};

// --- Inspection ---

handlers.get_selection = async function () {
  var selection = figma.currentPage.selection;
  return {
    count: selection.length,
    nodes: selection.map(function (n) { return serializeNode(n, 1); })
  };
};

handlers.get_page_structure = async function (params) {
  var maxDepth = params.maxDepth || 4;
  var page = figma.currentPage;
  return {
    pageId: page.id,
    pageName: page.name,
    children: page.children.map(function (child) {
      return serializeNode(child, maxDepth - 1);
    })
  };
};

handlers.read_node_properties = async function (params) {
  var node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) throw new Error('Node not found: ' + params.nodeId);
  var depth = params.depth !== undefined ? params.depth : 2;
  return serializeNode(node, depth);
};

handlers.find_nodes = async function (params) {
  var root = figma.currentPage;
  if (params.rootNodeId) {
    var r = await figma.getNodeByIdAsync(params.rootNodeId);
    if (!r) throw new Error('Root node not found: ' + params.rootNodeId);
    root = r;
  }

  var query = params.query ? params.query.toLowerCase() : null;
  var type = params.type ? params.type.toUpperCase() : null;
  var limit = params.limit || 50;
  var results = [];

  function search(node) {
    if (results.length >= limit) return;

    var matches = true;
    if (type && node.type !== type) matches = false;
    if (query && matches) {
      var nameMatch = node.name.toLowerCase().indexOf(query) !== -1;
      var textMatch = node.type === 'TEXT' && node.characters && node.characters.toLowerCase().indexOf(query) !== -1;
      if (!nameMatch && !textMatch) matches = false;
    }

    if (matches && node !== root) {
      results.push(serializeNode(node, 0));
    }

    if ('children' in node) {
      for (var i = 0; i < node.children.length; i++) {
        if (results.length >= limit) break;
        search(node.children[i]);
      }
    }
  }

  search(root);
  return { count: results.length, nodes: results };
};

handlers.get_local_styles = async function () {
  var paintStyles = figma.getLocalPaintStyles();
  var textStyles = figma.getLocalTextStyles();
  var effectStyles = figma.getLocalEffectStyles();

  return {
    colors: paintStyles.map(function (s) {
      var paint = s.paints.length > 0 ? s.paints[0] : null;
      var hex = null;
      if (paint && paint.type === 'SOLID') {
        hex = rgbToHex(paint.color.r, paint.color.g, paint.color.b);
      }
      return { id: s.id, name: s.name, description: s.description, color: hex };
    }),
    textStyles: textStyles.map(function (s) {
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        fontSize: s.fontSize,
        fontName: s.fontName,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing
      };
    }),
    effectStyles: effectStyles.map(function (s) {
      return { id: s.id, name: s.name, description: s.description, effects: s.effects };
    })
  };
};

handlers.list_components = async function (params) {
  var limit = params.limit || 100;
  var nameFilter = params.nameFilter ? params.nameFilter.toLowerCase() : null;
  var results = [];

  function searchNode(node) {
    if (results.length >= limit) return;

    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      if (!nameFilter || node.name.toLowerCase().indexOf(nameFilter) !== -1) {
        var info = {
          id: node.id,
          name: node.name,
          type: node.type,
          description: node.description || ''
        };
        if (node.type === 'COMPONENT') {
          info.key = node.key;
        }
        if (node.type === 'COMPONENT_SET' && 'children' in node) {
          info.variants = node.children.map(function (v) {
            return { id: v.id, name: v.name, key: v.key };
          });
        }
        results.push(info);
      }
    }

    if ('children' in node) {
      for (var i = 0; i < node.children.length; i++) {
        if (results.length >= limit) break;
        searchNode(node.children[i]);
      }
    }
  }

  if (params.pageOnly) {
    searchNode(figma.currentPage);
  } else {
    var pages = figma.root.children;
    for (var p = 0; p < pages.length; p++) {
      if (results.length >= limit) break;
      searchNode(pages[p]);
    }
  }

  return { count: results.length, components: results };
};

// --- Mutation ---

handlers.delete_node = async function (params) {
  var node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) throw new Error('Node not found: ' + params.nodeId);
  var name = node.name;
  node.remove();
  return { deleted: true, name: name };
};

handlers.move_to_parent = async function (params) {
  var node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) throw new Error('Node not found: ' + params.nodeId);
  var parent = await figma.getNodeByIdAsync(params.parentId);
  if (!parent) throw new Error('Parent not found: ' + params.parentId);
  if (!('appendChild' in parent)) throw new Error('Target parent cannot have children');

  if (params.index !== undefined) {
    parent.insertChild(params.index, node);
  } else {
    parent.appendChild(node);
  }
  return { nodeId: node.id, newParentId: parent.id };
};

handlers.set_selection = async function (params) {
  var nodes = [];
  for (var i = 0; i < params.nodeIds.length; i++) {
    var n = await figma.getNodeByIdAsync(params.nodeIds[i]);
    if (n) nodes.push(n);
  }
  figma.currentPage.selection = nodes;
  if (nodes.length > 0) figma.viewport.scrollAndZoomIntoView(nodes);
  return { selectedCount: nodes.length };
};

handlers.create_component_instance = async function (params) {
  var comp = await figma.getNodeByIdAsync(params.componentId);
  if (!comp) throw new Error('Component not found: ' + params.componentId);
  if (comp.type !== 'COMPONENT') throw new Error('Node is not a component: ' + comp.type);

  var instance = comp.createInstance();
  if (params.name) instance.name = params.name;
  instance.x = params.x || 0;
  instance.y = params.y || 0;
  if (params.width && params.height) instance.resize(params.width, params.height);

  if (params.parentId) {
    var parent = await getParentNode(params.parentId);
    parent.appendChild(instance);
  }

  return { nodeId: instance.id, name: instance.name, componentId: comp.id };
};

handlers.import_component_by_key = async function (params) {
  var comp = await figma.importComponentByKeyAsync(params.key);
  if (!comp) throw new Error('Could not import component with key: ' + params.key);

  // If it's a component set and a variant name was specified, find the variant
  var targetComponent = comp;
  if (comp.type === 'COMPONENT_SET' && params.variantName) {
    var variant = null;
    for (var i = 0; i < comp.children.length; i++) {
      if (comp.children[i].name === params.variantName) {
        variant = comp.children[i];
        break;
      }
    }
    if (!variant) throw new Error('Variant not found: ' + params.variantName);
    targetComponent = variant;
  }

  var instance = targetComponent.createInstance();
  if (params.name) instance.name = params.name;
  instance.x = params.x || 0;
  instance.y = params.y || 0;
  if (params.width && params.height) instance.resize(params.width, params.height);

  var parent = await getParentNode(params.parentId);
  parent.appendChild(instance);

  return { nodeId: instance.id, name: instance.name };
};

handlers.detach_instance = async function (params) {
  var node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) throw new Error('Node not found: ' + params.nodeId);
  if (node.type !== 'INSTANCE') throw new Error('Node is not an instance: ' + node.type);

  var detached = node.detachInstance();
  return { nodeId: detached.id, name: detached.name, type: detached.type };
};

// ─── Message Dispatcher ─────────────────────────────────────────────────────

figma.ui.onmessage = async function (msg) {
  if (msg.type !== 'command') return;

  var handler = handlers[msg.command];
  if (!handler) {
    figma.ui.postMessage({ type: 'error_response', id: msg.id, error: 'Unknown command: ' + msg.command });
    return;
  }

  try {
    var result = await handler(msg.params || {});
    figma.ui.postMessage({ type: 'response', id: msg.id, result: result });
  } catch (e) {
    figma.ui.postMessage({ type: 'error_response', id: msg.id, error: e.message || String(e) });
  }
};
