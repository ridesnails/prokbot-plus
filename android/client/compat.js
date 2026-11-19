// Compatibility for older Android System WebView builds, loaded before the interface and
// before the pairing page. The web client (web/) loads it too, in Safari and Firefox as well.
//
// The official interface is built for Electron's current Chromium. Its syntax needs Chromium
// 85 and `Intl.Segmenter` needs 87, but it also calls newer built-ins without checking for
// them: `URL.canParse` (Chromium 120), `Array.prototype.toSorted` (110), `findLast` (97),
// `Object.hasOwn` (93), `at` (92), `crypto.randomUUID` (92), `showPopover` (114) and others.
// On an older WebView the page parses, rendering throws, React unmounts the tree and the
// window stays blank. Missing built-ins are added here; nothing that works is replaced. The pairing
// page uses top-level await (Chromium 89), so 89 is the minimum for the app. If a page
// still does not start, the blank page is replaced by an explanation with the WebView version.
//
// A classic script in ES5 so that it runs, and can explain, on any WebView.
(function () {
  'use strict';
  var MINIMUM_CHROMIUM = 89, FULL_CHROMIUM = 111;
  var global = typeof globalThis !== 'undefined' ? globalThis : window;
  var hasOwnProperty = Object.prototype.hasOwnProperty;
  var added = [];

  function define(target, name, value, label) {
    if (!target || name in target) return;
    Object.defineProperty(target, name, { value: value, writable: true, configurable: true, enumerable: false });
    added.push(label);
  }

  function toIntegerOrInfinity(value) {
    var number = Number(value);
    if (number !== number || number === 0) return 0;
    return number === Infinity || number === -Infinity ? number : Math.trunc(number);
  }

  function lengthOf(object) {
    var length = toIntegerOrInfinity(object.length);
    return length <= 0 ? 0 : Math.min(length, 9007199254740991);
  }

  function relativeIndex(index, length) {
    var relative = toIntegerOrInfinity(index);
    return relative >= 0 ? relative : length + relative;
  }

  function requireCallable(value, name) {
    if (typeof value !== 'function') throw new TypeError(name + ': ' + String(value) + ' is not a function');
  }

  function at(index) {
    var object = Object(this), length = lengthOf(object), k = relativeIndex(index, length);
    return k < 0 || k >= length ? undefined : object[k];
  }

  function findLast(predicate, thisArg) {
    requireCallable(predicate, 'findLast');
    var object = Object(this);
    for (var i = lengthOf(object) - 1; i >= 0; i--) if (predicate.call(thisArg, object[i], i, object)) return object[i];
    return undefined;
  }

  function findLastIndex(predicate, thisArg) {
    requireCallable(predicate, 'findLastIndex');
    var object = Object(this);
    for (var i = lengthOf(object) - 1; i >= 0; i--) if (predicate.call(thisArg, object[i], i, object)) return i;
    return -1;
  }

  // Array copies read by index, so holes become undefined as in the specification.
  function arrayCopy(object) {
    var length = lengthOf(object), copy = new Array(length);
    for (var i = 0; i < length; i++) copy[i] = object[i];
    return copy;
  }

  function checkComparator(compare) {
    if (compare !== undefined && typeof compare !== 'function') throw new TypeError('The comparison function must be either a function or undefined');
  }

  var ArrayProto = Array.prototype;
  define(ArrayProto, 'at', at, 'Array.prototype.at');
  define(ArrayProto, 'findLast', findLast, 'Array.prototype.findLast');
  define(ArrayProto, 'findLastIndex', findLastIndex, 'Array.prototype.findLastIndex');
  define(ArrayProto, 'toReversed', function toReversed() { return arrayCopy(Object(this)).reverse(); }, 'Array.prototype.toReversed');
  define(ArrayProto, 'toSorted', function toSorted(compare) {
    checkComparator(compare);
    return arrayCopy(Object(this)).sort(compare);
  }, 'Array.prototype.toSorted');
  define(ArrayProto, 'toSpliced', function toSpliced() {
    var copy = arrayCopy(Object(this));
    ArrayProto.splice.apply(copy, arguments);
    return copy;
  }, 'Array.prototype.toSpliced');
  define(ArrayProto, 'with', function (index, value) {
    var copy = arrayCopy(Object(this)), k = relativeIndex(index, copy.length);
    if (k < 0 || k >= copy.length) throw new RangeError('Invalid index : ' + index);
    copy[k] = value;
    return copy;
  }, 'Array.prototype.with');
  define(String.prototype, 'at', function (index) {
    if (this === null || this === undefined) throw new TypeError('String.prototype.at called on null or undefined');
    return at.call(String(this), index);
  }, 'String.prototype.at');

  if (typeof Int8Array === 'function') {
    var TypedProto = Object.getPrototypeOf(Int8Array.prototype);
    define(TypedProto, 'at', at, 'TypedArray.prototype.at');
    define(TypedProto, 'findLast', findLast, 'TypedArray.prototype.findLast');
    define(TypedProto, 'findLastIndex', findLastIndex, 'TypedArray.prototype.findLastIndex');
    define(TypedProto, 'toReversed', function toReversed() { return this.slice().reverse(); }, 'TypedArray.prototype.toReversed');
    define(TypedProto, 'toSorted', function toSorted(compare) {
      checkComparator(compare);
      return this.slice().sort(compare);
    }, 'TypedArray.prototype.toSorted');
    define(TypedProto, 'with', function (index, value) {
      var copy = this.slice(), k = relativeIndex(index, copy.length);
      if (k < 0 || k >= copy.length) throw new RangeError('Invalid typed array index');
      copy[k] = value;
      return copy;
    }, 'TypedArray.prototype.with');
  }

  define(Object, 'hasOwn', function hasOwn(object, key) {
    if (object === null || object === undefined) throw new TypeError('Cannot convert undefined or null to object');
    return hasOwnProperty.call(Object(object), key);
  }, 'Object.hasOwn');

  if (typeof global.URL === 'function') {
    var NativeURL = global.URL;
    define(NativeURL, 'parse', function parse(url, base) {
      try { return arguments.length < 2 || base === undefined ? new NativeURL(url) : new NativeURL(url, base); }
      catch (error) { return null; }
    }, 'URL.parse');
    define(NativeURL, 'canParse', function canParse(url, base) {
      try {
        if (arguments.length < 2 || base === undefined) new NativeURL(url); else new NativeURL(url, base);
        return true;
      } catch (error) { return false; }
    }, 'URL.canParse');
  }

  if (typeof Promise === 'function') {
    define(Promise, 'withResolvers', function withResolvers() {
      var resolve, reject;
      var promise = new this(function (a, b) { resolve = a; reject = b; });
      return { promise: promise, resolve: resolve, reject: reject };
    }, 'Promise.withResolvers');
    define(Promise, 'try', function (callback) {
      var args = ArrayProto.slice.call(arguments, 1);
      return new this(function (resolve) { resolve(callback.apply(undefined, args)); });
    }, 'Promise.try');
  }

  // Error handlers in the interface call this unconditionally (Chromium 134).
  define(Error, 'isError', function isError(value) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
    return value instanceof Error || Object.prototype.toString.call(value) === '[object Error]' ||
      (typeof DOMException === 'function' && value instanceof DOMException);
  }, 'Error.isError');

  function cloneError(message) {
    try { return new DOMException(message, 'DataCloneError'); }
    catch (error) { var fallback = new Error(message); fallback.name = 'DataCloneError'; return fallback; }
  }

  // Synchronous structured clone of the data types the interface passes: plain objects,
  // arrays, dates, regular expressions, maps, sets, errors and binary data.
  function cloneValue(value, seen) {
    var type = typeof value;
    if (type === 'symbol') throw cloneError('Symbol() could not be cloned.');
    if (type === 'function') throw cloneError(String(value).slice(0, 60) + ' could not be cloned.');
    if (value === null || type !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    var tag = Object.prototype.toString.call(value), copy, i;
    if (Array.isArray(value)) {
      copy = new Array(value.length);
      seen.set(value, copy);
      for (i = 0; i < value.length; i++) if (hasOwnProperty.call(value, i)) copy[i] = cloneValue(value[i], seen);
      return copy;
    }
    switch (tag) {
      case '[object Date]': copy = new Date(value.getTime()); break;
      case '[object RegExp]': copy = new RegExp(value.source, value.flags); break;
      case '[object Boolean]': case '[object Number]': case '[object String]': copy = Object(value.valueOf()); break;
      case '[object ArrayBuffer]': copy = value.slice(0); break;
      case '[object Blob]': case '[object File]': return value;
      case '[object Map]':
        copy = new Map();
        seen.set(value, copy);
        value.forEach(function (item, key) { copy.set(cloneValue(key, seen), cloneValue(item, seen)); });
        return copy;
      case '[object Set]':
        copy = new Set();
        seen.set(value, copy);
        value.forEach(function (item) { copy.add(cloneValue(item, seen)); });
        return copy;
      case '[object Error]': {
        var Kind = { EvalError: EvalError, RangeError: RangeError, ReferenceError: ReferenceError,
          SyntaxError: SyntaxError, TypeError: TypeError, URIError: URIError }[value.name] || Error;
        copy = new Kind(value.message);
        seen.set(value, copy);
        if (typeof value.stack === 'string') copy.stack = value.stack;
        if (hasOwnProperty.call(value, 'cause')) copy.cause = cloneValue(value.cause, seen);
        return copy;
      }
      default:
        if (typeof ArrayBuffer === 'function' && ArrayBuffer.isView(value)) {
          var buffer = cloneValue(value.buffer, seen);
          copy = tag === '[object DataView]' ? new DataView(buffer, value.byteOffset, value.byteLength)
            : new value.constructor(buffer, value.byteOffset, value.length);
          break;
        }
        if (tag !== '[object Object]') throw cloneError(tag.slice(8, -1) + ' object could not be cloned.');
        copy = {};
        seen.set(value, copy);
        var keys = Object.keys(value);
        for (i = 0; i < keys.length; i++) copy[keys[i]] = cloneValue(value[keys[i]], seen);
        return copy;
    }
    seen.set(value, copy);
    return copy;
  }

  if (typeof Map === 'function') define(global, 'structuredClone', function structuredClone(value) {
    if (arguments.length === 0) throw new TypeError("Failed to execute 'structuredClone': 1 argument required, but only 0 present.");
    return cloneValue(value, new Map());
  }, 'structuredClone');

  var crypto = global.crypto;
  if (crypto && typeof crypto.getRandomValues === 'function' && !crypto.randomUUID) {
    define(Object.getPrototypeOf(crypto), 'randomUUID', function randomUUID() {
      var bytes = crypto.getRandomValues(new Uint8Array(16)), hex = [];
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      for (var i = 0; i < 16; i++) hex.push((bytes[i] + 0x100).toString(16).slice(1));
      return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' + hex.slice(6, 8).join('') + '-' +
        hex.slice(8, 10).join('') + '-' + hex.slice(10).join('');
    }, 'crypto.randomUUID');
  }

  // Popover API (Chromium 114): menus and tooltips call showPopover() directly. Without the
  // top layer an open popover is approximated by a fixed element above the page.
  if (typeof HTMLElement === 'function' && !('showPopover' in HTMLElement.prototype)) {
    var OPEN = 'data-grokbot-popover-open';
    var toggle = function (element, open) {
      if (element.hasAttribute(OPEN) === open) return;
      if (open) element.setAttribute(OPEN, ''); else element.removeAttribute(OPEN);
      var event = document.createEvent('Event');
      event.initEvent('toggle', false, false);
      event.oldState = open ? 'closed' : 'open';
      event.newState = open ? 'open' : 'closed';
      element.dispatchEvent(event);
    };
    define(HTMLElement.prototype, 'showPopover', function showPopover() { toggle(this, true); }, 'HTMLElement.prototype.showPopover');
    define(HTMLElement.prototype, 'hidePopover', function hidePopover() { toggle(this, false); }, 'HTMLElement.prototype.hidePopover');
    define(HTMLElement.prototype, 'togglePopover', function togglePopover(force) {
      var open = typeof force === 'boolean' ? force : !this.hasAttribute(OPEN);
      toggle(this, open);
      return open;
    }, 'HTMLElement.prototype.togglePopover');
    if (typeof document !== 'undefined' && document.head) {
      var style = document.createElement('style');
      style.textContent = '[popover]:not([' + OPEN + ']){display:none!important}[popover][' + OPEN + ']{position:fixed;z-index:2147483646}';
      document.head.appendChild(style);
    }
  }

  // moveBefore (Chromium 133): the 1.1.0 interface moves preview frames with it. A plain
  // insertBefore moves the node too; only the frame's state is not kept (it reloads).
  if (typeof Element === 'function' && !('moveBefore' in Element.prototype)) {
    var moveBefore = function moveBefore(node, child) { return this.insertBefore(node, child); };
    define(Element.prototype, 'moveBefore', moveBefore, 'Element.prototype.moveBefore');
    if (typeof DocumentFragment === 'function') define(DocumentFragment.prototype, 'moveBefore', moveBefore, 'DocumentFragment.prototype.moveBefore');
    if (typeof Document === 'function') define(Document.prototype, 'moveBefore', moveBefore, 'Document.prototype.moveBefore');
  }

  // ResizeObserver's device-pixel-content-box (Chromium 84; not in Safari, which the web client
  // also serves): the 1.1.0 interface sizes chat images with it, and Safari's observe() throws
  // on the unknown box, so every image in a conversation fails to render. There, observe() takes
  // the content box instead and entries report it scaled by the device pixel ratio.
  if (typeof ResizeObserver === 'function' && typeof ResizeObserverEntry === 'function' &&
      !('devicePixelContentBoxSize' in ResizeObserverEntry.prototype)) {
    var observeBox = ResizeObserver.prototype.observe;
    Object.defineProperty(ResizeObserver.prototype, 'observe', { writable: true, configurable: true, enumerable: true,
      value: function observe(target, options) {
        if (options && options.box === 'device-pixel-content-box') options = Object.assign({}, options, { box: 'content-box' });
        return observeBox.call(this, target, options);
      } });
    Object.defineProperty(ResizeObserverEntry.prototype, 'devicePixelContentBoxSize', { configurable: true, enumerable: true,
      get: function () {
        var ratio = global.devicePixelRatio || 1, box = this.contentBoxSize && this.contentBoxSize[0];
        var inline = box ? box.inlineSize : this.contentRect.width, block = box ? box.blockSize : this.contentRect.height;
        return Object.freeze([Object.freeze({ inlineSize: Math.round(inline * ratio), blockSize: Math.round(block * ratio) })]);
      } });
    added.push('ResizeObserver device-pixel-content-box');
  }

  // ---- startup check -----------------------------------------------------------------------

  var userAgent = (global.navigator && global.navigator.userAgent) || '';
  var chromiumMatch = /(?:Chrome|Chromium)\/(\d+)/.exec(userAgent);
  var chromium = chromiumMatch ? Number(chromiumMatch[1]) : 0;
  var boot = global.__grokbotAndroidBoot || {};
  var chinese = /^zh/i.test(boot.locale || boot.systemLocale || (global.navigator && global.navigator.language) || '');
  function t(zh, en) { return chinese ? zh : en; }

  var errors = [], lastErrorAt = 0;
  function remember(message) {
    message = String(message || '').replace(/\s+/g, ' ').trim();
    if (!message) return;
    lastErrorAt = Date.now();
    if (errors.indexOf(message) >= 0 || errors.length >= 5) return;
    errors.push(message.length > 300 ? message.slice(0, 300) + '…' : message);
  }

  var api = {
    minimumChromium: MINIMUM_CHROMIUM,
    chromium: chromium,
    added: added,
    errors: errors,
    /** Lines of the explanation shown when the interface did not start. */
    explanation: function () {
      var lines = [];
      if (chromium && chromium < MINIMUM_CHROMIUM) {
        lines.push(t('这台设备的 WebView 是 Chromium ' + chromium + '，太旧，无法运行界面。需要 Android System WebView ' +
          MINIMUM_CHROMIUM + ' 或更高版本，建议 ' + FULL_CHROMIUM + ' 以上。',
          'This device\'s WebView is Chromium ' + chromium + ', which is too old to run the interface. Android System WebView ' +
          MINIMUM_CHROMIUM + ' or later is required; ' + FULL_CHROMIUM + ' or later is recommended.'));
        lines.push(t('请在应用商店更新「Android System WebView」（部分系统为「Chrome」）。鸿蒙「卓易通」等兼容环境中的 WebView 可能无法单独更新。',
          'Update "Android System WebView" (on some systems, "Chrome") from the app store. The WebView inside compatibility layers such as HarmonyOS 卓易通 may not be updatable.'));
      } else {
        lines.push(t('界面启动时出错，页面没有显示出来。', 'The interface failed while starting, so the page stayed blank.'));
        if (chromium && chromium < FULL_CHROMIUM) lines.push(t('这台设备的 WebView 是 Chromium ' + chromium + '，建议更新到 ' + FULL_CHROMIUM + ' 或更高版本。',
          'This device\'s WebView is Chromium ' + chromium + '; updating to ' + FULL_CHROMIUM + ' or later is recommended.'));
      }
      return lines;
    },
    details: function () {
      var lines = [
        'ProkBot Plus Android ' + (boot.appVersion || '?') + ' · Android SDK ' + (boot.sdk || '?') + ' · WebView ' + (chromium ? 'Chromium ' + chromium : '?'),
      ];
      for (var i = 0; i < errors.length; i++) lines.push(errors[i]);
      return lines;
    },
  };
  global.__grokbotCompat = api;

  if (typeof document === 'undefined' || typeof global.addEventListener !== 'function') return;

  global.addEventListener('error', function (event) {
    var target = event.target;
    if (target && target !== global && target.tagName) {
      // Images and media fail for ordinary reasons; only the interface's own code and styles matter.
      if (!/^(SCRIPT|LINK)$/.test(target.tagName)) return;
      remember(t('无法加载 ', 'Could not load ') + (target.src || target.href));
    } else {
      var error = event.error, place = event.filename ? ' @ ' + String(event.filename).split('/').pop() + ':' + event.lineno : '';
      remember((event.message || (error && error.name ? error.name + ': ' + error.message : error)) + place);
    }
    schedule(1500);
  }, true);
  global.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    remember(reason && reason.message ? (reason.name ? reason.name + ': ' : '') + reason.message : reason);
    schedule(1500);
  });

  var overlay = null, timer = null, mounted = false;
  // The interface renders into #root; the pairing page sets __grokbotStarted after its first render.
  function root() { return document.getElementById('root'); }
  function rootEmpty() { var element = root(); return element ? !element.firstChild : global.__grokbotStarted !== true; }

  function schedule(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, delay);
  }

  function check() {
    timer = null;
    if (!rootEmpty()) {
      mounted = true;
      if (overlay) { overlay.parentNode && overlay.parentNode.removeChild(overlay); overlay = null; }
      return;
    }
    // A blank root after it had content is a crash only when something just failed.
    if (mounted && Date.now() - lastErrorAt > 10000) return;
    show();
  }

  function show() {
    if (overlay || !document.body) return;
    var dark = boot.systemDark === true;
    overlay = document.createElement('div');
    overlay.id = 'grokbot-compat-message';
    overlay.setAttribute('role', 'alert');
    overlay.style.cssText = 'position:fixed;inset:0;top:0;left:0;right:0;bottom:0;z-index:2147483647;overflow:auto;' +
      'padding:32px 24px;box-sizing:border-box;font:15px/1.6 system-ui,sans-serif;' +
      (dark ? 'background:#111;color:#eee' : 'background:#fff;color:#111');
    var title = document.createElement('h1');
    title.style.cssText = 'font-size:20px;margin:0 0 16px';
    title.textContent = t('界面没有正常启动', 'The interface did not start');
    overlay.appendChild(title);
    var lines = api.explanation();
    for (var i = 0; i < lines.length; i++) {
      var paragraph = document.createElement('p');
      paragraph.style.margin = '0 0 12px';
      paragraph.textContent = lines[i];
      overlay.appendChild(paragraph);
    }
    var details = document.createElement('pre');
    details.style.cssText = 'white-space:pre-wrap;word-break:break-word;font:12px/1.5 monospace;padding:12px;border-radius:8px;margin:16px 0;' +
      (dark ? 'background:#222' : 'background:#f2f2f2');
    details.textContent = api.details().join('\n');
    overlay.appendChild(details);
    var help = document.createElement('p');
    help.style.margin = '0 0 20px';
    help.textContent = t('反馈问题时请附上本页截图：', 'When reporting the problem, include a screenshot of this page: ');
    var link = document.createElement('a');
    link.href = 'https://github.com/ferretgeek/prokbot-plus/issues';
    link.textContent = 'github.com/ferretgeek/prokbot-plus/issues';
    link.style.color = dark ? '#8ab4f8' : '#1a56c4';
    help.appendChild(link);
    overlay.appendChild(help);
    overlay.appendChild(button(t('重新加载', 'Reload'), function () { global.location.reload(); }, dark));
    if (root()) overlay.appendChild(button(t('连接设置', 'Connection settings'), function () { global.location.href = '../client/connect.html'; }, dark));
    document.body.appendChild(overlay);
  }

  function button(label, action, dark) {
    var element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.style.cssText = 'display:block;width:100%;margin:0 0 12px;padding:12px;border-radius:10px;font:inherit;border:1px solid ' +
      (dark ? '#444;background:#222;color:#eee' : '#ccc;background:#fff;color:#111');
    element.addEventListener('click', action);
    return element;
  }

  function watch() {
    var element = root();
    if (element && typeof MutationObserver === 'function') {
      new MutationObserver(function () { schedule(element.firstChild ? 0 : 1500); }).observe(element, { childList: true });
    }
    // Below the minimum the module never runs; otherwise allow a slow phone time to parse.
    schedule(chromium && chromium < MINIMUM_CHROMIUM ? 1500 : 20000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
})();
