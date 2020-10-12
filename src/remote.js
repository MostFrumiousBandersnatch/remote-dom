/* eslint-env worker */

import {Node, Commands, Constants, MessagesQueue, StyleAttributes, EventDOMNodeAttributes, SupportedEvents} from './common';

function createScope() {
  let index = 0;
  let initMsgPromiseResolver;

  const queue = new MessagesQueue();
  const eventsByTypeAndTarget = {};
  const connectedElementsByIndex = {};

  const INLINE_EVENT = 'INLINE_EVENT';

  function addToQueue(command, host, args) {
    queue.push([command, ...args, host]);
  }

  class RemoteStyle {
    constructor ($index) {
      this.$index = $index;
      this.$values = {};
    }
  }

  StyleAttributes.forEach((k) => {
    Object.defineProperty(RemoteStyle.prototype, k, {
      set: function (val) {
        addToQueue(Commands.setStyle, this.$host, [this.$index, k, val]);
        this.$values[k] = val;
      },
      get: function () {
        return this.$values[k];
      }
    });
  });

  class RemoteNodeInternal {
    constructor (nodeType, val) {
      index++;
      this.nodeType = nodeType;
      this.$index = index;
      this.$host = null;
      this.parentNode = null;
      this.childNodes = [];
      this.$value = val;
    }

    toString() {
      return `RemoteNode({nodeType:${this.nodeType},index:${this.$index}})`;
    }

    get children () {
      return this.childNodes;
    }

    get firstChild () {
      return this.childNodes[0];
    }

    get nextSibling () {
      if (!this.parentNode) {
        return null;
      }
      const idx = this.parentNode.childNodes.indexOf(this);
      if (idx === -1 || idx === this.parentNode.childNodes.length - 1) {
        return null;
      }
      return this.parentNode.childNodes[idx + 1];
    }

    get prevSibling () {
      if (!this.parentNode) {
        return null;
      }
      const idx = this.parentNode.childNodes.indexOf(this);
      if (idx === -1 || idx === 0) {
        return null;
      }
      return this.parentNode.childNodes[idx - 1];
    }

    get ownerDocument () {
      return document;
    }

    set host (host) {
      if (Boolean(host) === Boolean(this.$host)) {
        return;
      }
      this.$host = host;
      if (host) {
        connectedElementsByIndex[this.$index] = this;
      } else {
        delete connectedElementsByIndex[this.$index];
      }
      this.childNodes.forEach((child) => {
        child.host = host;
      });
    }
    appendChild (child) {
      addToQueue(Commands.appendChild, this.$host, [this.$index, child.$index]);

      const childrenToAppend = child.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? child.childNodes : [child];
      this.childNodes.splice(this.childNodes.length, 0, ...childrenToAppend);
      childrenToAppend.forEach((childNode) => {
        childNode.parentNode = this;
        childNode.host = this.$host;
      });
    //add host recursively to all children
      return child;
    }

    insertBefore (child, refChild) {
      const idx = refChild ? this.childNodes.indexOf(refChild) : this.childNodes.length;
      if (!child) {
        throw new Error('no child');
      }
      if (idx === -1) {
        throw new Error("Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.");
      }

      addToQueue(Commands.insertBefore, this.$host, [this.$index, child.$index, refChild ? refChild.$index : null]);

      const childrenToInsert = child.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? child.childNodes : [child];
      this.childNodes.splice(idx, 0, ...childrenToInsert);
      childrenToInsert.forEach((childNode) => {
        childNode.parentNode = this;
        childNode.host = this.$host;
      });

      return child;
    }

    removeChild (child) {
      addToQueue(Commands.removeChild, this.$host, [this.$index, child.$index]);
      const idx = this.childNodes.indexOf(child);
      if (idx !== -1) {
        this.childNodes.splice(idx, 1);
      }
      child.host = null;
    }

    replaceChild (newChild, oldChild) {
      const idx = this.childNodes.indexOf(oldChild);
      if (idx === -1) {
        throw new Error("Failed to execute 'replaceChild' on 'Node': The node to be replaced is not a child of this node.");
      }

      addToQueue(Commands.replaceChild, this.$host, [this.$index, newChild.$index, oldChild.$index]);

      const childrenToInsert = newChild.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? newChild.childNodes : [newChild];
      this.childNodes.splice(idx, 1, ...childrenToInsert);
      childrenToInsert.forEach((childNode) => {
        childNode.parentNode = this;
        childNode.host = this.$host;
      });
      oldChild.parentNode = null;
      oldChild.host = null;
    }

    addEventListener (evtType, callback, capture) {
      addEventListener(this.$index, this.$host, evtType, callback, capture);
    }

    removeEventListener (evtType, callback) {
      removeEventListener(this.$index, this.$host, evtType, callback);
    }

    dispatchEvent (event) {
      dispatchEvent(this.$index, this.$host, event);
    }

    set value (val) {
      this.$value = val;
      addToQueue(Commands.setValue, this.$host, [this.$index, val]);
    }

    get value () {
      return this.$value;
    }

    get textContent () {
      return this.$textContent;
    }

    set textContent (val) {
      if (this.childNodes.length !== 1 || this.childNodes[0].nodeType !== Node.TEXT_NODE) {
        const childTextNode = new RemoteTextualNode(val);
        childTextNode.parentNode = this;
        childTextNode.$host = this.$host;
        this.childNodes = [childTextNode];
      }
      addToQueue(Commands.textContent, this.$host, [this.$index, val, this.childNodes[0].$index]);
    }

    invokeNative (name, args) {
      addToQueue(Commands.invokeNative, this.$host, [this.$index, name, args]);
    }
  }

  class RemoteNode extends RemoteNodeInternal {}

  SupportedEvents.forEach(evtType => {
    Object.defineProperty(RemoteNode.prototype, evtType, {
      get: function() {
        this.$eventHandlers = this.$eventHandlers || {};
        return this.$eventHandlers[evtType];
      },
      set: function(evtHandler) {
        this.$eventHandlers = this.$eventHandlers || {};
        this.$eventHandlers[evtType] = evtHandler;
        setEventListener(this.$index, this.$host, evtType.slice(2), evtHandler);
      }
    });
  });

  class RemoteTextualNode extends RemoteNode {
    constructor (text) {
      super(Node.TEXT_NODE, text);
      this.$value = text;
    }

    set nodeValue (val) {
      this.$value = val;
      addToQueue(Commands.textContent, this.$host, [this.$index, val]);
    }

    get nodeValue() {
      return this.$value;
    }
  }

  class RemoteComment extends RemoteTextualNode {
    constructor (text) {
      super(Node.COMMENT_NODE, text);
    }
  }

  class RemoteText extends RemoteTextualNode {
    constructor (text) {
      super(Node.TEXT_NODE, text);
    }
  }

  class RemoteElement extends RemoteNode {
    constructor (tagName, isTagNameCaseSensitive) {
      super(Node.ELEMENT_NODE);
      this.tagName = isTagNameCaseSensitive ? tagName : tagName.toUpperCase();
      this.$id = null;
      this.$style = new RemoteStyle(this.$index);
      this.$attr = {};
      this.$class = new Set();
    }

    get nodeName () {
      return this.tagName;
    }

    setAttribute (k, v) {
      addToQueue(Commands.setAttribute, this.$host, [this.$index, k, v]);
      this.$attr[k] = {name: k, value: v};
      this[k] = v;
      if (k === 'class') {
        this.$class.clear();
        for(const cl of v.split(' ')) {
          this.$class.add(cl);
        }
      }
    }

    getAttribute(k) {
      return this[k];
    }

    removeAttribute (k) {
      addToQueue(Commands.removeAttribute, this.$host, [this.$index, k]);
      delete this.$attr[k];
    }

    hasAttribute(k) {
      return this.$attr.hasOwnProperty(k);
    }

    focus () {
      addToQueue(Commands.focus, this.$host, [this.$index]);
    }

    scrollIntoView (options) {
      addToQueue(Commands.scrollIntoView, this.$host, [this.$index, options]);
    }

    scroll (options1, options2) {
      addToQueue(Commands.scroll, this.$host, [this.$index, options1, options2]);
    }

    scrollTo(options1, options2) {
      addToQueue(Commands.scrollTo, this.$host, [this.$index, options1, options2]);
    }

    scrollBy (options1, options2) {
      addToQueue(Commands.scrollBy, this.$host, [this.$index, options1, options2]);
    }

    setSelectionRange (selectionStart, selectionEnd, selectionDirection) {
      addToQueue(Commands.setSelectionRange, this.$host, [this.$index, selectionStart, selectionEnd, selectionDirection]);
    }

    set id(id) {
      addToQueue(Commands.setId, this.$host, [this.$index, id]);
      this.$id = id;
    }

    get id() {
      return this.$id;
    }

    get style() {
      return this.$style;
    }

    set style (val) {
      addToQueue(Commands.setStyle, this.$host, [this.$index, val]);
    }

    set innerHTML (val) {
      addToQueue(Commands.innerHTML, this.$host, [this.$index, val]);
      this.$innerHTML = val;
    }

    get innerHTML () {
      return this.$innerHTML;
    }

    set innerText (val) {
      addToQueue(Commands.innerText, this.$host, [this.$index, val]);
    }

    get className() {
      return Array.from(this.$class).join(' ');
    }

    set className(className) {
      addToQueue(Commands.className, this.$host, [this.$index, className]);
      const classes = className.split(' ');
      this.$class.clear();
      for(const cl of classes) {
        this.$class.add(cl);
      }
    }

    get classList() {
      const self = this;
      return {
        add: (cl) => {
          this.$class.add(cl);
          addToQueue(Commands.className, this.$host, [this.$index, Array.from(this.$class).join(' ')]);
        },
        remove: (cl) => {
          this.$class.delete(cl);
          addToQueue(Commands.className, this.$host, [this.$index, Array.from(this.$class).join(' ')]);
        },
        toggle: (cl) => {
          if(!this.$class.has(cl)) {
            this.class.add(cl);
          } else {
            this.class.delete(cl);
          }
          addToQueue(Commands.className, this.$host, [this.$index, Array.from(this.$class).join(' ')]);
        },
        contains: (cl) => {
          return this.$class.has(cl);
        },
        [Symbol.iterator]: function* () {
          for(const cl of self.$class) {
            yield cl;
          }
        }
      };
    }

    querySelector(query) {
      return querySelector(this, query);
    }

    querySelectorAll(query) {
      return querySelectorAll(this, query);
    }

    getElementById(id) {
      return getElementById(this, id);
    }
  }

  class RemoteContainer extends RemoteElement {
    constructor () {
      super('div');
      this.$host = this.$index;
    }
  }

  class RemoteFragment extends RemoteNode {
    constructor () {
      super(Node.DOCUMENT_FRAGMENT_NODE);
    }
  }

  class RemoteVideo extends RemoteElement {
    constructor () {
      super('video');
    }

    pause () {
      addToQueue(Commands.pause, this.$host, [this.$index]);
    }

    play () {
      addToQueue(Commands.play, this.$host, [this.$index]);
    }

    get src () {
      return this.$src;
    }

    set src (value) {
      this.$src = value;
      addToQueue(Commands.src, this.$host, [this.$index, value]);
    }
  }

  class RemoteImage extends  RemoteElement {
    constructor () {
      super('img');
    }

    get src () {
      return this.$src;
    }

    set src (value) {
      this.$src = value;
      addToQueue(Commands.src, this.$host, [this.$index, value]);
    }
  }

  class RemoteCanvasContext {

    constructor(canvas) {
      this.$properties = new Map();
      this.$properties.set('canvas', canvas);
      this.$properties.set('fillStyle', '#000');
      this.$properties.set('font', '10px sans-serif');
      this.$properties.set('globalAlpha', 1.0);
      this.$properties.set('globalCompositeOperation', 'source-over');
      this.$properties.set('imageSmoothingEnabled', true);
      this.$properties.set('lineCap', 'butt');
      this.$properties.set('lineDashOffset', 0.0);
      this.$properties.set('lineJoin', 'miter');
      this.$properties.set('lineWidth', 1.0);
      this.$properties.set('miterLimit', 10.0);
      this.$properties.set('shadowBlur', 0);
      this.$properties.set('shadowColor', 'rgba(0,0,0,0)');
      this.$properties.set('shadowOffsetX', 0);
      this.$properties.set('shadowOffsetY', 0);
      this.$properties.set('strokeStyle', '#000');
      this.$properties.set('textAlign', 'start');
      this.$properties.set('textBaseline', 'alphabetic');
      return new Proxy(this, {
        get: (object, key) => {
          if (this.$properties.has(key)) {
            return this.$properties.get(key);
          }
          return (...args) => {
            addToQueue(Commands.invokeContextMethod, canvas.$host, [canvas.$index, key, args]);
          };
        },
        set: (object, key, value) => {
          if (!this.$properties.has(key)) {
            throw new Error(`Setting canvas context method doesn't supported! [${key}]`);
          }
          if (['canvas'].includes(key)) {
            return false;
          }
          addToQueue(Commands.setContextProperty, canvas.$host, [canvas.$index, key, value]);
          this.$properties.set(key, value);
          return true;
        },
      });
    }

  }

  class RemoteCanvas extends RemoteElement {
    constructor() {
      super('canvas');
      this.$2dContext = new RemoteCanvasContext(this);
    }

    getContext (contextType) {
      switch(contextType) {
        case '2d':
          return this.$2dContext;
        default:
          throw new Error('Unsupported context type');
      }
    }
  }

  class RemoteInput extends RemoteElement {
    constructor () {
      super('input');
    }

    set value (val) {
      this.$value = val;
      addToQueue(Commands.setValue, this.$host, [this.$index, val]);
    }

    get value () {
      return this.$value;
    }
  }

  class RemoteSelect extends RemoteElement {
    constructor () {
      super('select');
    }

    get options () {
      return Array.from(this.children).filter(child => child.tagName.toLowerCase() === 'option');
    }
  }

  function createElement (nodeName) {
    let res;
    switch(nodeName) {
      case 'video':
        res = new RemoteVideo();
        break;
      case 'img':
        res = new RemoteImage();
        break;
      case 'input':
        res = new RemoteInput();
        break;
      case 'select':
        res = new RemoteSelect();
        break;
      case 'canvas':
        res = new RemoteCanvas();
        break;
      default:
        res = new RemoteElement(nodeName);
    }
    addToQueue(Commands.createElement, res.$host, [res.$index, res.tagName]);
    return res;
  }

  function createElementNS(namespaceURI, nodeName) {
    const res = new RemoteElement(nodeName, true);
    addToQueue(Commands.createElementNS, res.$host, [res.$index, namespaceURI, res.tagName]);
    return res;
  }

  function createTextNode (text) {
    const res = new RemoteText(text);
    addToQueue(Commands.createTextNode, res.$host, [res.$index, text]);
    return res;
  }

  function createComment (text) {
    const res = new RemoteComment(text);
    addToQueue(Commands.createComment, res.$host, [res.$index, text]);
    return res;
  }

  function createDocumentFragment () {
    const res = new RemoteFragment();
    addToQueue(Commands.createDocumentFragment, res.$host, [res.$index]);
    return res;
  }

  function createContainer (name) {
    name = name || Constants.DEFAULT_NAME;
    const res = new RemoteContainer();
    connectedElementsByIndex[res.$index] = res;
    addToQueue(Commands.createContainer, res.$host, [res.$index, name]);
    return res;
  }

  function addEventListener (target, host, evtName, callback, capture) {
    index++;
    eventsByTypeAndTarget[evtName] = eventsByTypeAndTarget[evtName] || {};
    eventsByTypeAndTarget[evtName][target] = eventsByTypeAndTarget[evtName][target] || {};
    eventsByTypeAndTarget[evtName][target][index] = callback;
    addToQueue(Commands.addEventListener, host, [target, evtName, index, capture]);
  }

  function removeEventListener (target, host, evtName, callback) {
    eventsByTypeAndTarget[evtName] = eventsByTypeAndTarget[evtName] || {};
    eventsByTypeAndTarget[evtName][target] = eventsByTypeAndTarget[evtName][target] || {};
    const evts = eventsByTypeAndTarget[evtName][target];
    const idx = Object.keys(evts).find((evtIndex) => {
      return evts[evtIndex] === callback;
    });
    delete evts[idx];
    addToQueue(Commands.removeEventListener, host, [target, evtName, index]);
  }

  function setEventListener(target, host, evtName, evtHandler) {
    eventsByTypeAndTarget[evtName] = eventsByTypeAndTarget[evtName] || {};
    eventsByTypeAndTarget[evtName][target] = eventsByTypeAndTarget[evtName][target] || {};
    if (evtHandler && !eventsByTypeAndTarget[evtName][target][INLINE_EVENT]) {
      addToQueue(Commands.addEventListener, host, [target, evtName, INLINE_EVENT, false]);
    } else if (!evtHandler && eventsByTypeAndTarget[evtName][target][INLINE_EVENT]) {
      addToQueue(Commands.removeEventListener, host, [target, evtName, INLINE_EVENT]);
    }
    if (typeof evtHandler === 'string') {
      evtHandler = Function('event', evtHandler);
    }
    eventsByTypeAndTarget[evtName][target][INLINE_EVENT] = evtHandler;
  }

  function dispatchEvent (target, host, event) {
    addToQueue(Commands.dispatchEvent, host, [target, event._type, event._eventInit, event._isCustom || false]);
  }

  function updateConnectedElement(index, eventData) {
    if (connectedElementsByIndex[index] && eventData[index]) {
      Object.assign(connectedElementsByIndex[index], eventData[index]);
    }
  }

  function handleMessagesFromPipe(messages) {
    messages.forEach(msg => {
      const evtIntent = msg[0];
      switch (evtIntent) {
        case (Constants.INIT): {
          initMsgPromiseResolver && initMsgPromiseResolver();
          const eventData = msg[1];
          Object.keys(eventData).forEach((index) => {
            updateConnectedElement(index, eventData);
          });
        }
          break;
        default: {
          const evtTarget = msg[1];
          const evtName = msg[2];
          const evtJSON = msg[3];
          Object.keys(evtJSON.extraData).forEach((index) => {
            updateConnectedElement(index, evtJSON.extraData);
          });
          EventDOMNodeAttributes.forEach((field) => {
            evtJSON[field] = (evtJSON[field] instanceof Array) ? evtJSON[field].map(val => connectedElementsByIndex[val]) : connectedElementsByIndex[evtJSON[field]];
          });

          if (eventsByTypeAndTarget[evtName] && eventsByTypeAndTarget[evtName][evtTarget]) {
            Object.keys(eventsByTypeAndTarget[evtName][evtTarget]).forEach((callbackIndex) => {
              eventsByTypeAndTarget[evtName][evtTarget][callbackIndex](evtJSON);
            });
          }
        }
      }
    });
  }

  function setChannel(channel, timerFunction) {
    const initMsgPromise = new Promise(resolve => {initMsgPromiseResolver = resolve;});

    queue.setPipe(channel, handleMessagesFromPipe, timerFunction);
    queue.push([Commands.initiated]);

    return initMsgPromise;
  }

  function Image(width, height) {
    const imgNode = document.createElement('img');
    imgNode.setAttribute('width', width);
    imgNode.setAttribute('height', height);
    return imgNode;
  }

  function getTokenByPath(childToParentArray, exact = false) {
    if (childToParentArray.length === 0) return null;
    const elmPath = childToParentArray.pop();
    if (elmPath === '>') {
      return getTokenByPath(childToParentArray, true);
    }
    const token = {
      tag: elmPath.match(/^[a-zA-Z]+[0-9a-zA-Z]*/gi),
      id: elmPath.match(/\#[a-zA-Z]+[0-9\-\_a-zA-Z]*/gi),
      classes: elmPath.match(/\.[a-zA-Z]+[0-9\-\_a-zA-Z]*/gi),
      attributes: elmPath.match(/\[[a-zA-Z]+[0-9a-zA-Z]*([\^\$\*]?[\=][a-zA-Z]+[0-9a-zA-Z]*)?\]/gi),
      parent: getTokenByPath(childToParentArray),
      exact: exact,
    };
    return token;
  }

  function getTokensByQuery(xPath) {
    const paths = xPath.split(',');
    const tokens = [];
    for(let path of paths) {
      path = path
        .replace(/>/gi, ' > ')
        .replace(/\s+/gi, ' ');
      const token = getTokenByPath(path.split(' '));
      tokens.push(token);
    }
    return tokens;
  }

  function matchToken(elm, token) {
    if (!matchProperties(elm, token)) return false;
    while(token.parent && elm.parentNode) {
      token = token.parent;
      elm = elm.parentNode;
      if (token.exact && !matchProperties(elm, token)) return false;
      if (!token.exact) {
        while(elm && !matchProperties(elm, token)) {
          elm = elm.parentNode;
        }
        if (!elm) return false;
      }
    }
    if (token.parent) return false;
    return true;
  }

  function matchProperties(elm, token) {
    if(!matchTag(elm, token.tag)) return false;
    if(!matchId(elm, token.id)) return false;
    if(!matchClasses(elm, token.classes)) return false;
    if(!matchAttributes(elm, token.attributes)) return false;
    return true;
  }

  function matchTag(elm, tags) {
    return !tags || elm.tagName.toLowerCase() === tags[0].toLowerCase();
  }

  function matchId(elm, ids) {
    return !ids || ids.length === 1 && ids.includes(`#${elm.id}`);
  }

  function matchClasses(elm, classes) {
    if (!classes) return true;
    for(const cl of classes) {
      if (!elm.classList.contains(cl.slice(1))) return false;
    }
    return true;
  }

  function matchAttributes(elm, attributes) {
    if (!attributes) return true;
    for(const dirtyAttrRecord of attributes) {
      const cleanRecord = dirtyAttrRecord.slice(1, -1);
      const [attributeName, attributeValue] = cleanRecord.split('=');
      if (!elm.hasAttribute(attributeName)) return false;
      if(attributeValue) {
        const prefix = attributeName.slice(attributeName.length - 1);
        const realAttributeValue = elm.getAttribute(attributeName);
        switch(prefix) {
          case '^':
            if(!realAttributeValue.startsWith(attributeValue)) return false;
            break;
          case '$':
            if(!realAttributeValue.endsWith(attributeValue)) return false;
            break;
          case '*':
            if(!realAttributeValue.includes(attributeValue)) return false;
            break;
          default:
            if(realAttributeValue !== attributeValue) return false;
        }
      }
    }
    return true;
  }

  function getMatchedElements(elm, token) {
    const elms = [];
    if (!elm) return elms;
    if (matchToken(elm, token)) {
      elms.push(elm);
    }
    if (elm.childNodes) {
      for(const node of elm.childNodes) {
        elms.push(...getMatchedElements(node, token));
      }
    }
    return elms;
  }

  function querySelectorAll(elm, query) {
    const results = [];
    const tokens = getTokensByQuery(query);
    for(const token of tokens) {
      if (elm.childNodes.length === 0) break;
      for(const child of elm.childNodes) {
        results.push(...getMatchedElements(child, token));
      }
    }
    return results;
  }

  function querySelector(elm, query) {
    return querySelectorAll(elm, query)[0];
  }

  function getElementById(elm, id) {
    return querySelectorAll(elm, `#${id}`)[0];
  }

  function populateGlobalScope(scope) {
    scope.window = window;
    scope.document = document;
    scope.requestAnimationFrame = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
    scope.Image = Image;
  }

  const document = {
    createElement,
    createTextNode,
    createComment,
    createDocumentFragment,
    addEventListener: addEventListener.bind(null, Constants.DOCUMENT, null),
    removeEventListener: removeEventListener.bind(null, Constants.DOCUMENT, null),
    documentElement: new RemoteElement('html'),
    dispatchEvent: dispatchEvent.bind(null, Constants.DOCUMENT, null),
    createElementNS,
    querySelector: query => querySelector(document.documentElement, query),
    querySelectorAll: query => querySelectorAll(document.documentElement, query),
    getElementById: id => getElementById(document.documentElement, id),
  };

  SupportedEvents.forEach((e) => {
    document[e] = addEventListener.bind(null, Constants.DOCUMENT, null, e.substr(2));
  });

  class Event {
    constructor (typeArg, eventInit) {
      this._type = typeArg;
      this._eventInit = eventInit;
    }
  }

  class CustomEvent extends Event {
    constructor (typeArg, customEventInit) {
      super(typeArg, customEventInit);
      this._isCustom = true;
    }
  }

  const window = {
    Event,
    CustomEvent,
    dispatchEvent: dispatchEvent.bind(null, Constants.WINDOW, null),
    addEventListener: addEventListener.bind(null, Constants.WINDOW, null),
    removeEventListener: removeEventListener.bind(null, Constants.WINDOW, null),
    document: document,
    location: {href: 'https://localhost', protocol: 'https:'},
    navigator: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/54.0.2840.98 Safari/537.36'
    },
    history: {},
    requestAnimationFrame: setTimeout,
    cancelAnimationFrame: clearTimeout,
    Image: Image
  };
  window.top = window;

  connectedElementsByIndex[Constants.WINDOW] = window;
  connectedElementsByIndex[Constants.DOCUMENT] = document;

  return {
    window,
    document,
    populateGlobalScope,
    createContainer,
    setChannel,
    queue
  };
}

const {
  window,
  document,
  populateGlobalScope,
  createContainer,
  setChannel
} = createScope();

export {
  window,
  document,
  populateGlobalScope,
  createContainer,
  setChannel,
  createScope
};
