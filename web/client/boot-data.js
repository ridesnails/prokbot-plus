// Start-up data of the web client, the counterpart of the boot script the Android shell
// serves. The Host serves this bundle itself, so the page's own origin is the Host and the
// settings and interface state live in this browser's localStorage. A classic script in ES5:
// it runs before compat.js, every module and the interface.
(function () {
  'use strict';
  var SETTINGS = 'grokbot-web:settings', PERSISTENCE = 'grokbot-web:persistence';
  function read(key) {
    try {
      var value = JSON.parse(window.localStorage.getItem(key) || 'null');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) { return {}; }
  }
  var settings = read(SETTINGS);
  var systemLocale = navigator.language || 'en';
  var query = new URLSearchParams(location.search);
  var agent = query.get('agent');
  // ?agent= opens that Bot once; reloading the page keeps the Bot the user is on.
  if (agent !== null) {
    query.delete('agent');
    var rest = query.toString();
    history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  }
  var dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false;
  var apple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  window.__grokbotAndroidBoot = {
    client: 'web',
    clientKind: 'web',
    appVersion: 'web',
    connectPage: '/web/login',
    systemLocale: systemLocale,
    locale: settings.language && settings.language !== 'system' ? settings.language : systemLocale,
    systemDark: dark,
    appOrigin: location.origin,
    vncOrigin: location.origin,
    connection: { paired: true, connected: true, server: location.origin, tailcat: false, transportPath: 'direct', error: '' },
    settings: settings,
    persistence: read(PERSISTENCE),
    pendingAgent: agent && /^[A-Za-z0-9_-]{1,128}$/.test(agent) ? agent : null,
    apple: apple,
  };

  // The Host accepts this browser's sign-in cookie on its device API only together with this
  // header. Another site cannot add it without a CORS preflight, which the Host never grants.
  var DEVICE_API = /^\/(api\/|events$|local\/|connect\/|notifications(\/|$))/;
  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      if (url.origin === location.origin && DEVICE_API.test(url.pathname)) {
        var headers = new Headers(init && init.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined);
        headers.set('x-grokbot-web', '1');
        init = Object.assign({}, init, { headers: headers });
      }
    } catch (error) { /* Not a URL the Host serves; send it unchanged. */ }
    return originalFetch.call(this, input, init);
  };

  // Android browsers resize the page with the on-screen keyboard instead of covering the message
  // field; Safari does not know that setting, and web-shell.js follows its visible area instead.
  // On iPhone and iPad a field below 16 px would also zoom the page; pinch zoom stays available.
  var viewport = document.querySelector('meta[name=viewport]');
  if (viewport) viewport.setAttribute('content', 'width=device-width, initial-scale=1' +
    (apple ? ', maximum-scale=1' : ', interactive-widget=resizes-content'));
  document.documentElement.classList.add('grokbot-web');
  if (apple) document.documentElement.classList.add('grokbot-apple');
})();
