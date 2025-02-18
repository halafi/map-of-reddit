import { createScene } from 'w-gl';
import createSVGLoader from './createSVGLoader';
import {getPointsFromPathData, getElementFillColor} from 'streaming-svg-parser';
import PointCollection from './PointCollection';
import PolyLineCollection from './PolyLineCollection';
import TextCollection from './MSDFTextCollection';
import bus, {setProgress} from './bus';
import createFuzzySearcher from './createFuzzySearcher';
import {debounce, formatNumber} from './utils'
import appState from '../appState';
import createGraph from 'ngraph.graph';
import createSubgraphVisualizer from './createSubgraphVisualizer';
import createPointerEventsHandler from './createPointerEventsHandler';
import createSceneLayerManager from './createSceneLayerManager';
import {Colors, LayerLevels, NamedGroups} from './constants';

export default function createStreamingSVGRenderer(canvas) {
  let ignoreSVGViewBox = false;
  let scene = initScene();
  let fuzzySearcher = createFuzzySearcher();
  window.fuzzySearcher = fuzzySearcher; // TODO: Don't use window.

  let persistedName = appState.query;
  let nodes = new PointCollection(scene.getGL());
  let boundariesFill = new PolyLineCollection(scene.getGL(), {color: 0x124182a4, opacity: 1.0});

  let text = new TextCollection(scene.getGL());
  let loader;
  let viewBox;
  let currentTransform = createTransformParser();
  let positions = [];

  const nodeNameToUI = new Map();
  const nodesByComponent = new Map();
  const complimentaryColor = new Map();
  const clusterColors = new Map();

  const setProgressDebounced = debounce(setProgress, 100, window);
  let subgraphVisualizer;
  const sceneLayerManager = createSceneLayerManager(scene);

  sceneLayerManager.addToLayer(boundariesFill, LayerLevels.Polygons);
  sceneLayerManager.addToLayer(nodes, LayerLevels.Nodes);
  sceneLayerManager.addToLayer(text, LayerLevels.Text);

  sceneLayerManager.addToNamedGroup(boundariesFill, NamedGroups.MainGraph);
  sceneLayerManager.addToNamedGroup(nodes, NamedGroups.MainGraph);
  sceneLayerManager.addToNamedGroup(text, NamedGroups.MainGraph);

  // This is our bread and butter for touch/mouse event handling
  const pointerEvents = createPointerEventsHandler(sceneLayerManager, {
    elementsGroupName: NamedGroups.MainGraph,
    onTransform: () => {
      // we don't want to update the query string when subgraph is active
      if (subgraphVisualizer) return;

      appState.saveScenePosition(scene);
    },
    getGraph: () => loader && loader.getGraph(),
    getHighlightedNodes,
    getHighlightedLinks,
  });

  bus.on('focus-node', focusNode);
  bus.on('unfocus', unfocus);
  bus.on('exit-subgraph', exitSubgraphMode);

  return {
    loadSVG,
    focus() {
      canvas.focus();
    },
    dispose,
    showRelated,
    getScene() {
      return scene;
    },
  };

  function getHighlightedNodes(ui) {
    let graph = loader && loader.getGraph();
    if (!graph) return [];

    const neighbors = nodesByComponent.get(ui.componentId);
    const hlNode = {...nodeNameToUI.get(ui.name)};
    hlNode.color = Colors.PRIMARY_HIGHLIGHT_COLOR ;
    let nodeUIs = [hlNode];
    graph.forEachLinkedNode(ui.name, (other) => {
      const hlNode = {...nodeNameToUI.get(other.id)};
      hlNode.color = Colors.SECONDARY_HIGHLIGHT_COLOR;
      nodeUIs.push(hlNode);
      if (!neighbors.has(other.id)) return;
    });

    return nodeUIs;
  }

  function getHighlightedLinks(ui) {
    let graph = loader && loader.getGraph();
    if (!graph) return [];

    let maxLinks = 10;
    let neighbors = nodesByComponent.get(ui.componentId);
    let secondaryLinkColor = complimentaryColor.get(ui.componentId);
    let idx;
    let linkUIs = [];

    neighbors.forEach((neighborId) => {
      idx = 0;
      graph.forEachLinkedNode(neighborId, (other) => {
        if (!neighbors.has(other.id)) return;
        let isFirstLevel = neighborId === ui.name || other.id === ui.name;
        if (idx > maxLinks && !isFirstLevel) return;
        linkUIs.push({
          from: nodeNameToUI.get(neighborId).position,
          to: nodeNameToUI.get(other.id).position,
          color: isFirstLevel ? 0xffffffff : secondaryLinkColor, 
          isFirstLevel
        });
        idx += 1;
      });
    });

    return linkUIs;
  }

  function showRelated(subreddit) {
    let subgraph = createGraph();
    subgraph.addNode(subreddit, {isRoot: true});

    let graph = loader.getGraph();
    let subgraphNodes = new Set();
    addNeighbors(subreddit, subgraphNodes);

    Array.from(subgraphNodes).forEach(node => {
      addNeighbors(node, subgraphNodes);
    });

    subgraphNodes.forEach(node => {
      let addedNode = subgraph.getNode(node);
      if (!addedNode || !addedNode.data) {
        let isFirstChild = graph.hasLink(node, subreddit) || graph.hasLink(subgraph, node);
        subgraph.addNode(node, {isFirstChild});
      }

      graph.forEachLinkedNode(node, (otherNode, link) => {
        if (!subgraphNodes.has(otherNode.id)) return;
        if (subgraph.hasLink(link.fromId, link.toId)) return;

        let isRootLevel = (link.fromId === subreddit) || (link.toId === subreddit);
        subgraph.addLink(link.fromId, link.toId, {isRootLevel});
      });
    });

    pointerEvents.setPaused(true); // let the subgraph to handle the events
    if (subgraphVisualizer) {
      // we don't want any animation here. Dispose right away!
      subgraphVisualizer.dispose();
      subgraphVisualizer = null;
    } 
    runSubGraphVisualizer();

    function addNeighbors(node, neighborsSet) {
      graph.forEachLinkedNode(node, otherNode => {
        neighborsSet.add(otherNode.id);
      });
    }

    function runSubGraphVisualizer() {
      subgraphVisualizer = createSubgraphVisualizer(subgraph, viewBox, sceneLayerManager, nodeNameToUI)
      subgraphVisualizer.run();
    }
  }

  function dispose() {
    if (loader) loader.dispose();
    bus.off('focus-node', focusNode);
    bus.off('unfocus', unfocus);
    bus.off('exit-subgraph', exitSubgraphMode);

    pointerEvents.dispose();
    scene.dispose();
  }

  function focusNode(nodeName) {
    // this means they entered something in the search box
    let ui = nodeNameToUI.get(nodeName);
    if (!ui) return;

    let [cx, cy] = ui.position;
    let size = (ui.size || 10) * 2;
    scene.setViewBox({
      left: cx - size,
      top: cy - size,
      right: cx + size,
      bottom: cy + size,
    });

    if (subgraphVisualizer) {
      subgraphVisualizer.dispose(() => {
        pointerEvents.setPaused(false); // we take care of the events now
      });
      subgraphVisualizer = null;
    }

    pointerEvents.focusUI(ui);
    scene.renderFrame();
  }

  function unfocus() {
    // This means they closed the sidebar
    pointerEvents.clearHighlights();

    scene.renderFrame();
  }

  function exitSubgraphMode() {
    if (subgraphVisualizer) {
      subgraphVisualizer.dispose(() => {
        pointerEvents.setPaused(false); // take care of the events now
      });
      subgraphVisualizer = null;
    }
  }

  function loadSVG(path) {
    if (loader) loader.dispose();

    loader = createSVGLoader(path)
      .on('element-start', handleElementStart)
      .on('element-end', handleElementEnd)
      .load();
  }

  function handleElementStart(element) {
    // TODO: this would be better done with FSM
    if (element.tagName === 'svg') {
      let viewBoxArr = (element.attributes.get('viewBox') || '0 0 1024 1024')
        .split(' ')
        .map((x) => Number.parseFloat(x))
        .filter(finiteNumber);

      if (viewBoxArr.length !== 4) throw new Error('Unknown viewBox definition: ' + element.attributes.get('viewBox'));

      viewBox = {
        left: viewBoxArr[0],
        top: viewBoxArr[1],
        width: viewBoxArr[2],
        height: viewBoxArr[3],
      };

      if (!ignoreSVGViewBox) {
        scene.setViewBox({
          left: viewBox.left,
          top: viewBox.top,
          right: viewBox.left + viewBox.width,
          bottom: viewBox.top + viewBox.height,
        });
      }
    } else if (element.tagName === 'path') {
      addBorder(element);
    } else if (element.tagName === 'circle') {
      addNode(element);
    } else {
      let transform = element.attributes.get('transform');
      if (transform) currentTransform.pushTransform(transform);
    }
  }

  function handleElementEnd(element) {
    let transform = element.attributes.get('transform');
    if (transform) currentTransform.popTransform(transform);
  }

  function addNode(el) {
    let x = getNumericAttribute(el, 'cx');
    let y = transformY(getNumericAttribute(el, 'cy'));
    let r = getNumericAttribute(el, 'r');
    let nodeName = getTextAttribute(el, 'id');
    if (nodeName[0] === '_') nodeName = nodeName.substr(1);
    if (nodeNameToUI.has(nodeName)) {
      throw new Error('Duplicate node name ' + nodeName);
    }
    let componentId = getTextAttribute(el.parent, 'id');
    let neighbors = nodesByComponent.get(componentId);
    if (!neighbors) {
      neighbors = new Set();
      nodesByComponent.set(componentId, neighbors);
    }
    neighbors.add(nodeName);

    let position = currentTransform.transform(x, y);
    let ui = {
      componentId,
      position,
      color: 0xdcdcdcff,
      size: r * 2,
      id: positions.length,
      name: nodeName,
    };
    nodeNameToUI.set(nodeName, ui);
    positions.push(ui);
    pointerEvents.addNode(ui);
    nodes.add(ui);

    text.addText({
      x: position[0],
      y: position[1] - r,
      text: nodeName,
      limit: 3.14 * r,
      cx: 0.5,
    });
    fuzzySearcher.addWord(nodeName);

    setProgressDebounced(getLoadedSubreddits);
    scene.renderFrame();
    if (persistedName && nodeName === persistedName && appState.query === persistedName && !appState.userTypedSomething) {
      bus.fire('show-subreddit', nodeName);
    }
  }

  function getLoadedSubreddits() {
    return {
      message: 'Loaded ' + formatNumber(nodeNameToUI.size) + ' subreddits...'
    };
  }

  function transformY(y) {
    return viewBox.height + viewBox.top - y;
  }

  function addBorder(el) {
    let { points, color } = parseBorder(el);
    boundariesFill.addPolygon({ polygon: points, color: color });
    let clusterId = el.attributes.get('id').substr(1);
    clusterColors.set(clusterId, color)
    complimentaryColor.set(clusterId, getComplimentaryColor(color));
    scene.renderFrame();
  }

  function getComplimentaryColor(color, lightningFactor = 1.4, alpha = 0xaa) {
    let r = (color >> 24) & 0xff;
    let g = (color >> 16) & 0xff;
    let b = (color >> 8) & 0xff;
    let [h, s, l] = rgbToHsl(r, g, b);
    if (l > 0.5) lightningFactor = .8;
    let [r0, g0, b0] = hslToRgb(h, s, Math.min(1, l * lightningFactor));
    // let r0 = Math.max(r, b, g) + Math.min(r,b,g) - r;
    // let b0 = Math.max(r, b, g) + Math.min(r,b,g) - b;
    // let g0 = Math.max(r, b, g) + Math.min(r,b,g) - g;
    return (r0 << 24) | (g0 << 16) | (b0 << 8) | alpha;
  }
function rgbToHsl(r, g, b) {
  r /= 255, g /= 255, b /= 255;

  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var h, s, l = (max + min) / 2;

  if (max == min) {
    h = s = 0; // achromatic
  } else {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }

    h /= 6;
  }

  return [ h, s, l ];
}

function hslToRgb(h, s, l) {
  var r, g, b;

  if (s == 0) {
    r = g = b = l; // achromatic
  } else {
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;

    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];

    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    }
}

  function initScene() {
    let scene = createScene(canvas, { 
      allowPinchRotation: false,
      maxZoom: 1500000,
      minZoom: 50
    });

    scene.setClearColor(0x0f / 255, 0x0f / 255, 0x0f / 255, 1);

    let cameraPosition = appState.getCameraPosition();
    if (cameraPosition) {
      // This is a bit fragile, but it works:
      let position = scene.getDrawContext().view.position;
      position[0] = cameraPosition[0];
      position[1] = cameraPosition[1];
      position[2] = cameraPosition[2];
      scene.getCamera().setViewBox();
      ignoreSVGViewBox = true;
    } else {
      let initialSceneSize = 500;
      scene.setViewBox({
        left: -initialSceneSize,
        top: -initialSceneSize,
        right: initialSceneSize,
        bottom: initialSceneSize,
      });
    }
    return scene;
  }

  function parseBorder(el) {
    let points = getPointsFromPathData(el.attributes.get('d')).map(([x, y]) => {
      let [x0, y0] = currentTransform.transform(x, transformY(y));
      return [x0, y0];
    });
    let color = hexColor(getElementFillColor(el));
    return { points, color };
  }
}

function createTransformParser() {
  let isDirty = false;
  let tx = 0,
    ty = 0;
  let transformStack = [];

  return {
    pushTransform,
    popTransform,
    transform,
  };

  function pushTransform(transformStr) {
    isDirty = true;
    transformStack.push(parseTransform(transformStr));
  }

  function popTransform() {
    if (transformStack.length === 0) throw new Error('Nothing to pop');
    transformStack.pop();
    isDirty = true;
  }

  function parseTransform(str) {
    let transformNumbers = str.match(/matrix\((.+)\)$/i);
    if (!transformNumbers)
      throw new Error('Unknown transformation record: ' + str);
    let coefficients = transformNumbers[1]
      .split(',')
      .map((x) => Number.parseFloat(x))
      .filter(finiteNumber);
    if (coefficients.length !== 6)
      throw new Error('Only matrix(a,b,c,d,e,f) is supported at the moment');
    return coefficients;
  }

  function transform(x, y) {
    updateTransform();
    return [x + tx, y - ty, 0];
  }

  function updateTransform() {
    if (!isDirty) return;

    // TODO: this should be real math
    tx = 0;
    ty = 0;
    transformStack.forEach((record) => {
      tx += record[4];
      ty += record[5];
    });
    isDirty = false;
  }
}

function finiteNumber(x) {
  return Number.isFinite(x);
}
function getNumericAttribute(el, name) {
  let value = Number.parseFloat(el.attributes.get(name));
  if (!Number.isFinite(value))
    throw new Error(
      'Element ' +
        el.tagName +
        ' does not have a finite numeric attribute ' +
        name
    );
  return value;
}

function getTextAttribute(el, name) {
  return el.attributes.get(name) || '';
}

function hexColor(rgbArray) {
  return (rgbArray[0] << 24) | (rgbArray[1] << 16) | (rgbArray[2] << 8) | 0xff;
}

