// ==UserScript==
// @name         Following → repositories of followed users
// @namespace    https://github.com/x0cdn
// @version      1.0.3
// @description  wif - What I Follow
// @author       topsh
// @downloadURL  https://raw.githubusercontent.com/x0cdn/wif/main/following-repos.user.js
// @updateURL    https://raw.githubusercontent.com/x0cdn/wif/main/following-repos.user.js
// @supportURL   https://github.com/x0cdn/wif/issues
// @grant        none
// @run-at       document-end
// ==/UserScript==

/*
 * Works on https://github.com/<user>?tab=following
 *
 * Data source: GET https://api.github.com/users/<login>/repos
 * Results are cached in localStorage for 6 hours
 * (unauthenticated API limit is 60 requests per hour).
 */

(function () {
  'use strict';

  var API = 'https://api.github.com/users/';
  var CACHE_PREFIX = 'wif:repos:';
  var CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
  var MAX_VISIBLE = 2;               // followed users
  var PINNED_MAX_VISIBLE = 8;        // own card keeps its current setting

  var parts = location.pathname.split('/').filter(Boolean);
  var ownerLogin = decodeURIComponent(parts[0] || '');

  function isFollowingPage() {
    return parts.length === 1 &&
      new URLSearchParams(location.search).get('tab') === 'following';
  }
  if (!isFollowingPage()) return;

  function isOwner(login) {
    return ownerLogin && login.toLowerCase() === ownerLogin.toLowerCase();
  }

  var queue = [];
  var busy = false;
  var pinnedPanel = null;

  // GitHub allows inline <style> (style-src 'unsafe-inline'), so media
  // queries work without GM_addStyle
  var style = document.createElement('style');
  style.setAttribute('data-wif-style', '');
  style.textContent = [
    '.wif-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));',
    'gap:12px 16px;align-items:start}',
    '@media (max-width:900px){.wif-list{grid-template-columns:minmax(0,1fr)}}',
    '.wif-card{min-width:0;max-width:100%;box-sizing:border-box}',
    // Override the GitHub row table: a fixed avatar column keeps user names
    // from overlapping avatars in narrow cards
    '.wif-card>.d-table{display:flex!important;align-items:flex-start;',
    'gap:10px;width:100%!important}',
    '.wif-card>.d-table>.d-table-cell{display:block!important;float:none!important}',
    '.wif-card>.d-table>.d-table-cell:first-child{flex:0 0 65px;',
    'width:65px!important;max-width:65px}',
    '.wif-card>.d-table>.d-table-cell:first-child img{width:65px!important;',
    'height:65px!important;max-width:none!important}',
    '.wif-card>.d-table>.d-table-cell:nth-child(2){flex:1 1 auto;',
    'width:auto!important;min-width:0}',
    '.wif-card>.d-table>.d-table-cell:last-child{flex:0 0 auto;width:auto!important}',
    '.wif-card>.d-table .user-following-container{margin-left:auto}',
    '.wif-pinned{grid-column:1/-1;margin-bottom:4px!important}'
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);

  function css(node, text) { node.style.cssText = text; return node; }

  function make(tag, text, style) {
    var node = document.createElement(tag);
    if (text != null) node.textContent = String(text);
    if (style) css(node, style);
    return node;
  }

  function getContainer() {
    var frame = document.getElementById('user-profile-frame');
    if (frame) {
      var inner = frame.querySelector('[data-hpc]');
      if (inner) return inner;
    }
    var first = document.querySelector('.user-following-container');
    if (!first) return null;
    var row = first.closest('.d-table');
    return row ? row.parentNode : null;
  }

  function readCache(login) {
    try {
      var raw = localStorage.getItem(CACHE_PREFIX + login);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || Date.now() - data.time > CACHE_TTL) return null;
      return data.repos;
    } catch (e) { return null; }
  }

  function writeCache(login, repos) {
    try {
      localStorage.setItem(CACHE_PREFIX + login,
        JSON.stringify({ time: Date.now(), repos: repos }));
    } catch (e) { /* works fine without a cache */ }
  }

  function renderPanel(panel, login, repos, error) {
    panel.textContent = '';

    var pinned = panel.getAttribute('data-wif-pinned') === '1';

    var head = make('div', null,
      'display:flex;align-items:center;gap:8px;flex-wrap:wrap;' +
      'font-size:12px;line-height:1.4;margin-bottom:6px;');

    head.appendChild(make('span', pinned ? '📌 My repositories' : '▸ Repositories',
      'font-weight:600;color:' + (pinned ? '#1a7f37' : '#57606a') + ';'));

    var profile = make('a', '@' + login,
      'color:#0969da;text-decoration:none;font-weight:600;');
    profile.href = '/' + encodeURIComponent(login) + '?tab=repositories';
    profile.target = '_blank';
    profile.rel = 'noopener noreferrer';
    head.appendChild(profile);

    if (!error) head.appendChild(make('span', '(' + repos.length + ')', 'color:#57606a;'));

    var refresh = make('a', '↻',
      'color:#0969da;text-decoration:none;font-size:14px;cursor:pointer;');
    refresh.href = '#';
    refresh.title = 'Refresh repositories';
    refresh.addEventListener('click', function (ev) {
      ev.preventDefault();
      try { localStorage.removeItem(CACHE_PREFIX + login); } catch (e) {}
      panel.textContent = '';
      loadRepos(panel, login, true);
    });
    head.appendChild(refresh);
    panel.appendChild(head);

    if (error) {
      panel.appendChild(make('div', error, 'color:#cf222e;font-size:12px;padding:2px 0;'));
      var retry = make('a', 'retry',
        'color:#0969da;text-decoration:none;font-size:12px;cursor:pointer;');
      retry.href = '#';
      retry.addEventListener('click', function (ev) {
        ev.preventDefault();
        try { localStorage.removeItem(CACHE_PREFIX + login); } catch (e) {}
        var sourceRow = panel.previousElementSibling;
        if (sourceRow) {
          sourceRow.removeAttribute('data-wif-processed');
          sourceRow.removeAttribute('data-wif-queued');
        }
        panel.remove();
        scheduleScan();
      });
      panel.appendChild(retry);
      return;
    }

    if (!repos.length) {
      panel.appendChild(make('div', 'No public repositories',
        'color:#57606a;font-size:12px;'));
      return;
    }

    var list = make('div', null, 'display:block;min-width:0;');
    panel.appendChild(list);

    function addRepo(repo, index) {
      var row = make('div', null,
        'display:block;font-size:12px;line-height:1.5;margin:2px 0 5px;min-width:0;');

      var title = make('div', null,
        'display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;min-width:0;');

      title.appendChild(make('span', '•', 'color:#8c959f;flex:none;'));

      // Show the full repository name on a single line, without truncation
      var link = make('a', repo.name,
        'color:#0969da;text-decoration:none;font-weight:600;white-space:nowrap;');
      link.href = repo.html_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = repo.full_name;
      title.appendChild(link);

      if (repo.fork) {
        title.appendChild(make('span', 'fork', 'color:#8c959f;font-size:11px;flex:none;'));
      }
      if (repo.archived) {
        title.appendChild(make('span', 'archived', 'color:#8c959f;font-size:11px;flex:none;'));
      }
      if (repo.stargazers_count > 0) {
        title.appendChild(make('span', '★ ' + repo.stargazers_count,
          'color:#8c959f;font-size:11px;flex:none;'));
      }
      row.appendChild(title);

      var desc = repo.description ||
        (repo.language ? 'language: ' + repo.language : 'No description');
      row.appendChild(make('div', '— ' + desc,
        'margin-left:13px;color:#57606a;white-space:normal;overflow-wrap:anywhere;min-width:0;'));

      row.setAttribute('data-wif-index', String(index));
      list.appendChild(row);
    }

    var visible = Math.min(repos.length, pinned ? PINNED_MAX_VISIBLE : MAX_VISIBLE);
    for (var i = 0; i < visible; i++) addRepo(repos[i], i);

    if (repos.length > visible) {
      var more = make('a', 'Show ' + (repos.length - visible) + ' more',
        'color:#0969da;text-decoration:none;font-size:12px;' +
        'display:inline-block;margin-top:4px;cursor:pointer;');
      more.href = '#';
      var expanded = false;
      more.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (!expanded) {
          for (var j = visible; j < repos.length; j++) addRepo(repos[j], j);
          more.textContent = 'Show less';
          expanded = true;
        } else {
          var rows = list.querySelectorAll('[data-wif-index]');
          for (var k = visible; k < rows.length; k++) rows[k].remove();
          more.textContent = 'Show ' + (repos.length - visible) + ' more';
          expanded = false;
        }
      });
      panel.appendChild(more);
    }
  }

  function loadRepos(panel, login, force) {
    panel.appendChild(make('div', 'Loading repositories…',
      'color:#57606a;font-size:12px;'));

    // Own repositories are refreshed on every page load so newly created
    // repos show up immediately, without waiting for the cache to expire
    var alwaysFresh = panel.getAttribute('data-wif-pinned') === '1';
    var cached = (!alwaysFresh && !force) ? readCache(login) : null;
    if (cached) {
      renderPanel(panel, login, cached, null);
      return;
    }

    fetch(API + encodeURIComponent(login) + '/repos?per_page=100&sort=updated', {
      headers: { 'Accept': 'application/vnd.github+json' },
      credentials: 'omit',
      cache: 'no-store'
    })
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 403 || res.status === 429) {
            throw new Error('GitHub API rate limit exceeded (try again later)');
          }
          if (res.status === 404) throw new Error('Profile or repositories unavailable');
          throw new Error('GitHub API error: HTTP ' + res.status);
        }
        return res.json();
      })
      .then(function (repos) {
        if (!Array.isArray(repos)) throw new Error('Unexpected API response');
        repos.sort(function (a, b) { return new Date(b.updated_at) - new Date(a.updated_at); });
        var short = repos.map(function (r) {
          return {
            name: r.name,
            full_name: r.full_name,
            html_url: r.html_url,
            description: r.description,
            language: r.language,
            fork: r.fork,
            archived: r.archived,
            stargazers_count: r.stargazers_count
          };
        });
        writeCache(login, short);
        renderPanel(panel, login, short, null);
      })
      .catch(function (err) {
        renderPanel(panel, login, null, String(err.message || err));
      });
  }

  function makePanel(login, pinned) {
    var panel = make('div', null,
      'margin:4px 0 12px 0;padding:8px 10px;' +
      'border:1px solid ' + (pinned ? '#1a7f37' : '#d0d7de') + ';' +
      'border-radius:6px;background:' + (pinned ? '#f0fff4' : '#f6f8fa') + ';' +
      'color:#1f2328;min-width:0;max-width:100%;box-sizing:border-box;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;');
    panel.setAttribute('data-wif-panel', login);
    if (pinned) {
      panel.setAttribute('data-wif-pinned', '1');
      panel.classList.add('wif-pinned');
    }
    return panel;
  }

  // Own panel stays first in the list, but is not sticky while scrolling
  function ensurePinned(container) {
    if (!ownerLogin || pinnedPanel) return;
    if (document.querySelector('[data-wif-pinned="1"]')) {
      pinnedPanel = document.querySelector('[data-wif-pinned="1"]');
      return;
    }
    pinnedPanel = makePanel(ownerLogin, true);
    container.insertBefore(pinnedPanel, container.firstElementChild);
    loadRepos(pinnedPanel, ownerLogin);
  }

  function keepPinnedTop(container) {
    if (!pinnedPanel || pinnedPanel.parentNode !== container) return;
    if (container.firstElementChild !== pinnedPanel) {
      container.insertBefore(pinnedPanel, container.firstElementChild);
    }
  }

  // Mirror the CSS with inline styles: even if the external <style> is not
  // applied, avatars and user names must never overlap
  function fixRowLayout(row) {
    var cells = row.children;
    if (cells.length < 2) return;
    css(row, row.style.cssText +
      'display:flex!important;align-items:flex-start;gap:10px;width:100%!important;');
    css(cells[0], cells[0].style.cssText +
      'flex:0 0 65px;width:65px!important;max-width:65px;');
    var img = cells[0].querySelector('img');
    if (img) css(img, img.style.cssText +
      'width:65px!important;height:65px!important;max-width:none!important;');
    css(cells[1], cells[1].style.cssText +
      'flex:1 1 auto;width:auto!important;min-width:0;');
    if (cells[2]) {
      css(cells[2], cells[2].style.cssText +
        'flex:0 0 auto;width:auto!important;');
    }
  }

  function processRow(row, login, container) {
    if (isOwner(login)) return; // the owner already has a pinned panel

    row.setAttribute('data-wif-processed', login);
    fixRowLayout(row);

    var old = document.querySelectorAll('[data-wif-panel="' + login + '"]');
    for (var i = 0; i < old.length; i++) {
      if (old[i] !== pinnedPanel) old[i].remove();
    }

    var panel = makePanel(login, false);

    // Wrap the user row and its panel into a single card
    var card = make('div', null, 'min-width:0;max-width:100%;box-sizing:border-box;');
    card.setAttribute('data-wif-card', login);
    card.classList.add('wif-card');
    row.parentNode.insertBefore(card, row);
    card.appendChild(row);
    card.appendChild(panel);

    loadRepos(panel, login);
  }

  function cleanupDuplicates() {
    var panels = document.querySelectorAll('[data-wif-panel]');
    var seen = {};
    for (var i = 0; i < panels.length; i++) {
      var panel = panels[i];
      if (panel === pinnedPanel || panel.getAttribute('data-wif-pinned') === '1') continue;

      var login = panel.getAttribute('data-wif-panel');
      var row = panel.previousElementSibling;
      var valid = row && row.getAttribute('data-wif-processed') === login;
      if (!valid || seen[login]) {
        panel.remove();
        continue;
      }
      seen[login] = true;
      row.setAttribute('data-wif-queued', login);
    }
  }

  function scan() {
    if (!isFollowingPage()) return;
    var container = getContainer();
    if (!container) return;

    container.classList.add('wif-list');

    ensurePinned(container);
    cleanupDuplicates();
    keepPinnedTop(container);

    // Apply the layout fix to rows created by an older version as well
    var oldRows = document.querySelectorAll('.d-table[data-wif-processed]');
    for (var j = 0; j < oldRows.length; j++) fixRowLayout(oldRows[j]);

    var links = document.querySelectorAll(
      'a[data-hovercard-url][href], a[data-hovercard-type][href]'
    );

    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      if (link.closest('[data-wif-panel]')) continue;

      var href = link.getAttribute('href') || '';
      var match = href.match(/^\/([A-Za-z0-9][A-Za-z0-9-]*)\/?$/);
      if (!match) continue;

      var row = link.closest('.d-table') || link.parentElement;
      if (!row || !row.querySelector('.user-following-container')) continue;

      var login = match[1];
      if (isOwner(login)) continue;

      // Each row has two links (avatar and name): mark it immediately so the
      // second link cannot queue a duplicate
      if (row.getAttribute('data-wif-queued') === login) continue;
      if (row.getAttribute('data-wif-processed') === login) continue;
      var next = row.nextElementSibling;
      if (next && next.getAttribute('data-wif-panel') === login) continue;

      row.setAttribute('data-wif-queued', login);
      queue.push({ row: row, login: login, container: container });
    }
    pump();
  }

  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    var item = queue.shift();
    processRow(item.row, item.login, item.container);
    setTimeout(function () { busy = false; pump(); }, 200);
  }

  var timer = null;
  function scheduleScan() {
    clearTimeout(timer);
    timer = setTimeout(scan, 250);
  }

  var observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });

  scheduleScan();
  window.addEventListener('pageshow', scheduleScan);
})();
