/**
 * Sweeparr Jellyfin web-client injection (§8.2) — TangyTheme variant.
 *
 * Self-contained sibling of sweeparr.js. Use when TangyTheme (or Zesty fork)
 * is installed via Dashboard → Branding → Custom CSS:
 *   @import url('https://cdn.jsdelivr.net/gh/jpereira99/TangyTheme/theme.css');
 *
 * Load from:  {sweeparr}/static/inject/sweeparr-tangy.js
 *
 * Doctrine: it must fail SILENTLY and COMPLETELY. A broken selector across a
 * Jellyfin release must never break playback UI.
 */
(function () {
	'use strict';

	var SWEEPARR_ORIGIN = (window.SWEEPARR_ORIGIN || '').replace(/\/$/, '');
	if (!SWEEPARR_ORIGIN) {
		SWEEPARR_ORIGIN = '';
	}

	var cache = {};
	var STYLE_ID = 'sweeparr-tangy-style';
	var CARD_SELECTOR = '.card[data-id]';

	// TangyTheme :root defaults — edit here; fallbacks in injectStyle() follow automatically.
	var TANGY = {
		white: '243,242,243',
		cherryRed: '212,51,83',
		darkest: '25,25,25',
		accent: '255,255,255',
		rounding: '12px',
	};

	function cssVar(name, fallback) {
		return 'var(--' + name + ',' + fallback + ')';
	}

	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		var css =
			'.swp-indicator{display:inline-flex;align-items:center;' +
			"font:700 10px/1.2 'indivisible',sans-serif;" +
			'color:rgb(' +
			cssVar('white', TANGY.white) +
			');' +
			'background:rgba(' +
			cssVar('cherry-red', TANGY.cherryRed) +
			',1);' +
			'border-radius:' +
			cssVar('rounding', TANGY.rounding) +
			';padding:0.6em 0.6em;pointer-events:none;' +
			'white-space:nowrap;box-shadow:-1px 1px 5px 1px rgba(' +
			cssVar('darkest', TANGY.darkest) +
			',.5)}' +
			'.swp-indicator--ribbon{position:absolute;left:0;top:0;z-index:2;margin:0;' +
			'border-radius:' +
			cssVar('rounding', TANGY.rounding) +
			' 0!important;text-shadow:none}' +
			'.swp-banner{display:flex;gap:12px;align-items:center;' +
			'margin:0 0 0.75em;padding:0.65em 0.9em;' +
			'border:1px solid rgba(' +
			cssVar('cherry-red', TANGY.cherryRed) +
			',.75);' +
			'background:rgba(' +
			cssVar('cherry-red', TANGY.cherryRed) +
			',.45);' +
			'border-radius:' +
			cssVar('rounding', TANGY.rounding) +
			';' +
			'color:rgb(' +
			cssVar('white', TANGY.white) +
			');' +
			"font:600 13px/1.4 'indivisible',sans-serif;" +
			'backdrop-filter:blur(5px)}' +
			'.swp-banner button.swp-keep-btn{margin-left:auto;white-space:nowrap;border:0;border-radius:' +
			cssVar('rounding', TANGY.rounding) +
			';padding:0.45em 0.75em;font:600 13px/1 ' +
			"'indivisible',sans-serif;cursor:pointer;color:rgb(" +
			cssVar('darkest', TANGY.darkest) +
			');background:rgba(' +
			cssVar('accent', TANGY.accent) +
			',.95)}' +
			'.swp-modal-backdrop{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;' +
			'justify-content:center;padding:16px;background:rgba(' +
			cssVar('darkest', TANGY.darkest) +
			',.78);backdrop-filter:blur(5px)}' +
			'.swp-modal{position:relative;width:100%;max-width:320px;max-height:min(90vh,560px);overflow:hidden;' +
			'border:1px solid rgba(' +
			cssVar('white', TANGY.white) +
			',.14);border-radius:' +
			cssVar('rounding', TANGY.rounding) +
			';background:rgb(' +
			cssVar('darkest', TANGY.darkest) +
			');color:rgb(' +
			cssVar('white', TANGY.white) +
			");font:600 13px/1.45 'indivisible',sans-serif;" +
			'box-shadow:-1px 1px 12px 2px rgba(' +
			cssVar('darkest', TANGY.darkest) +
			',.65)}' +
			'.swp-modal *,.swp-modal *::before,.swp-modal *::after{box-sizing:border-box}' +
			'.swp-modal__close{position:absolute;top:8px;right:8px;z-index:1;border:0;background:transparent;' +
			'color:rgba(' +
			cssVar('white', TANGY.white) +
			',.55);font:22px/1 sans-serif;cursor:pointer;padding:6px 8px;line-height:1}' +
			'.swp-modal__body{padding:18px 18px 20px}' +
			'.swp-modal__title{margin:0 28px 2px 0;font:700 15px/1.3 ' +
			"'indivisible',sans-serif;color:rgb(" +
			cssVar('white', TANGY.white) +
			')}' +
			'.swp-modal__size{margin:0 0 10px;font:600 10.5px/1.2 ' +
			"'indivisible',monospace;color:rgba(" +
			cssVar('white', TANGY.white) +
			',.62)}' +
			'.swp-modal__badge{display:inline-flex;align-items:center;gap:4px;margin:0 0 10px;padding:0.35em 0.65em;border-radius:999px;' +
			'border:1px solid rgba(' +
			cssVar('cherry-red', TANGY.cherryRed) +
			',.55);background:rgba(' +
			cssVar('cherry-red', TANGY.cherryRed) +
			',.32);font:700 10.5px/1 ' +
			"'indivisible',sans-serif;color:rgb(" +
			cssVar('white', TANGY.white) +
			');text-transform:uppercase;letter-spacing:.02em}' +
			'.swp-modal__reason{margin:0 0 0;font:12px/1.45 ' +
			"'indivisible',sans-serif;color:rgba(" +
			cssVar('white', TANGY.white) +
			',.78)}' +
			'.swp-modal__rule{height:1px;margin:12px 0;background:rgba(' +
			cssVar('white', TANGY.white) +
			',.12)}' +
			'.swp-modal__label{display:block;margin:0 0 6px;font:11px/1.3 ' +
			"'indivisible',sans-serif;color:rgba(" +
			cssVar('white', TANGY.white) +
			',.55)}' +
			'.swp-modal__meta{margin:0;font:12px/1.45 ' +
			"'indivisible',sans-serif;color:rgba(" +
			cssVar('white', TANGY.white) +
			',.78)}' +
			'.swp-modal__title+.swp-modal__meta{margin-top:8px}' +
			'.swp-modal__note{display:block;width:100%;min-height:64px;margin:0 0 12px;padding:10px;border-radius:' +
			cssVar('rounding', TANGY.rounding) +
			';border:1px solid rgba(' +
			cssVar('white', TANGY.white) +
			',.18);background:rgba(' +
			cssVar('darkest', TANGY.darkest) +
			',.65);color:rgb(' +
			cssVar('white', TANGY.white) +
			");font:12px/1.4 'indivisible',sans-serif;resize:none;outline:none}" +
			'.swp-modal__note:focus{border-color:rgba(' +
			cssVar('white', TANGY.white) +
			',.35)}' +
			'.swp-modal__submit{display:block;width:100%;border:0;border-radius:' +
			cssVar('rounding', TANGY.rounding) +
			';padding:12px;font:700 14px/1 ' +
			"'indivisible',sans-serif;cursor:pointer;color:rgb(" +
			cssVar('darkest', TANGY.darkest) +
			');background:rgba(' +
			cssVar('accent', TANGY.accent) +
			',.95)}' +
			'.swp-modal__submit:disabled{opacity:.65;cursor:wait}' +
			'.swp-modal__hint{margin:12px 0 0;font:11px/1.4 ' +
			"'indivisible',sans-serif;color:rgba(" +
			cssVar('white', TANGY.white) +
			',.5);text-align:center}' +
			'.swp-modal__ok{display:flex;align-items:center;justify-content:center;width:44px;height:44px;' +
			'margin:8px auto 12px;border-radius:999px;border:1px solid rgba(' +
			cssVar('accent', TANGY.accent) +
			',.45);background:rgba(' +
			cssVar('accent', TANGY.accent) +
			',.16);color:rgb(' +
			cssVar('accent', TANGY.accent) +
			');font:20px/1 sans-serif}';
		var el = document.createElement('style');
		el.id = STYLE_ID;
		el.textContent = css;
		(document.head || document.documentElement).appendChild(el);
	}

	function extractIds() {
		var ids = {};
		try {
			var m = (location.hash || '').match(/[?&]id=([a-f0-9]{32})/i);
			if (m) ids[m[1]] = true;
			document.querySelectorAll(CARD_SELECTOR).forEach(function (n) {
				var id = n.getAttribute('data-id');
				if (id && /^[a-f0-9]{32}$/i.test(id)) ids[id] = true;
			});
		} catch (e) {}
		return Object.keys(ids);
	}

	function fetchFlags(ids, cb) {
		var need = ids.filter(function (id) {
			return cache[id] === undefined;
		});
		if (!need.length) return cb();
		var url = SWEEPARR_ORIGIN + '/flags?jellyfin_ids=' + need.join(',');
		fetch(url, { credentials: 'omit' })
			.then(function (r) {
				return r.ok ? r.json() : { items: [] };
			})
			.then(function (data) {
				need.forEach(function (id) {
					cache[id] = null;
				});
				(data.items || []).forEach(function (it) {
					cache[it.jellyfin_id] = it;
				});
				cb();
			})
			.catch(function () {
				need.forEach(function (id) {
					cache[id] = null;
				});
				cb();
			});
	}

	function fmt(dateStr) {
		try {
			if (!dateStr) return '';
			var d = new Date(dateStr.indexOf('T') >= 0 ? dateStr : dateStr + 'T00:00:00');
			return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		} catch (e) {
			return dateStr;
		}
	}

	function appendCardIndicator(card, flag) {
		if (card.querySelector('.swp-indicator')) return;
		var image = card.querySelector('.cardImageContainer');
		if (!image) return;

		var badge = document.createElement('div');
		badge.className = 'swp-indicator swp-indicator--ribbon';
		badge.textContent = 'Leaving ' + fmt(flag.delete_at);
		image.appendChild(badge);
	}

	function closeKeepModal(backdrop) {
		try {
			if (backdrop && backdrop._swpOnKey) {
				document.removeEventListener('keydown', backdrop._swpOnKey);
			}
			if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
		} catch (e) {}
	}

	function keepTitle(data) {
		var title = data.title || 'This item';
		if (data.season_number) title += ' — Season ' + data.season_number;
		return title;
	}

	function renderKeepModalBody(modal, html) {
		var body = modal.querySelector('.swp-modal__body');
		if (body) body.innerHTML = html;
	}

	function openKeepModal(flag) {
		var token = flag && flag.token;
		if (!token || !SWEEPARR_ORIGIN) return;

		var backdrop = document.createElement('div');
		backdrop.className = 'swp-modal-backdrop';
		backdrop.innerHTML =
			'<div class="swp-modal" role="dialog" aria-modal="true" aria-label="Request to Keep">' +
			'<button type="button" class="swp-modal__close" aria-label="Close">&times;</button>' +
			'<div class="swp-modal__body">Loading…</div></div>';

		var modal = backdrop.querySelector('.swp-modal');
		var onKey = function (e) {
			if (e.key === 'Escape') closeKeepModal(backdrop);
		};

		backdrop.querySelector('.swp-modal__close').addEventListener('click', function (e) {
			e.preventDefault();
			e.stopPropagation();
			closeKeepModal(backdrop);
		});
		backdrop.addEventListener('click', function (e) {
			if (e.target === backdrop) closeKeepModal(backdrop);
		});
		modal.addEventListener('click', function (e) {
			e.stopPropagation();
		});
		document.addEventListener('keydown', onKey);
		backdrop._swpOnKey = onKey;

		document.body.appendChild(backdrop);

		fetch(SWEEPARR_ORIGIN + '/api/v1/keep/' + encodeURIComponent(token), {
			credentials: 'omit',
		})
			.then(function (r) {
				return r.ok ? r.json() : null;
			})
			.then(function (data) {
				if (!data) {
					renderKeepModalBody(modal, '<p class="swp-modal__meta">This link has expired or the item is no longer leaving.</p>');
					return;
				}
				if (data.status !== 'pending' || data.id) {
					renderKeepModalBody(
						modal,
						'<div class="swp-modal__ok">✓</div>' +
							'<p class="swp-modal__title">Request already sent</p>' +
							'<p class="swp-modal__meta">' +
							keepTitle(data) +
							' stays put until an admin decides. Deletion is paused while your request is pending.</p>',
					);
					return;
				}

				renderKeepModalBody(
					modal,
					'<p class="swp-modal__title">' +
						keepTitle(data) +
						'</p>' +
						(data.size_gb != null ? '<p class="swp-modal__size">' + data.size_gb + ' GB</p>' : '') +
						'<span class="swp-modal__badge">⏱ Leaves ' +
						fmt(data.delete_at) +
						'</span>' +
						'<p class="swp-modal__reason">Why: ' +
						(data.reason_public || '') +
						'</p>' +
						'<div class="swp-modal__rule"></div>' +
						'<label class="swp-modal__label">Add a note (optional)</label>' +
						'<textarea class="swp-modal__note"></textarea>' +
						'<button type="button" class="swp-modal__submit">Request to Keep</button>',
				);

				var noteEl = modal.querySelector('.swp-modal__note');
				var submitBtn = modal.querySelector('.swp-modal__submit');
				submitBtn.addEventListener('click', function (e) {
					e.preventDefault();
					e.stopPropagation();
					submitBtn.disabled = true;
					submitBtn.textContent = 'Sending…';
					fetch(SWEEPARR_ORIGIN + '/api/v1/keep/' + encodeURIComponent(token), {
						method: 'POST',
						credentials: 'omit',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ reason: noteEl ? noteEl.value : '' }),
					})
						.then(function (r) {
							return r.ok ? r.json() : null;
						})
						.then(function (result) {
							if (!result) {
								submitBtn.disabled = false;
								submitBtn.textContent = 'Request to Keep';
								return;
							}
							renderKeepModalBody(
								modal,
								'<div class="swp-modal__ok">✓</div>' +
									'<p class="swp-modal__title">Request sent</p>' +
									'<p class="swp-modal__meta">' +
									keepTitle(result) +
									' stays put until an admin decides. Deletion is paused while your request is pending.</p>' +
									'<p class="swp-modal__hint">Close this to return to Jellyfin.</p>',
							);
						})
						.catch(function () {
							submitBtn.disabled = false;
							submitBtn.textContent = 'Request to Keep';
						});
				});
			})
			.catch(function () {
				renderKeepModalBody(
					modal,
					'<p class="swp-modal__meta">Could not reach Sweeparr. Check that it is running and reachable.</p>',
				);
			});
	}

	function renderDetailBanner(flag) {
		if (document.querySelector('.swp-banner')) return;
		var detail = document.querySelector('.detailSectionContent');
		if (!detail) return;
		if (!flag.token || !SWEEPARR_ORIGIN) return;

		var banner = document.createElement('div');
		banner.className = 'swp-banner';
		var text = document.createElement('span');
		text.textContent = 'Leaving ' + fmt(flag.delete_at) + ' — ' + (flag.reason_public || '');
		var btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'swp-keep-btn';
		btn.textContent = 'Request to Keep';
		btn.addEventListener(
			'click',
			function (e) {
				e.preventDefault();
				e.stopPropagation();
				openKeepModal(flag);
			},
			true,
		);
		banner.appendChild(text);
		banner.appendChild(btn);
		detail.insertBefore(banner, detail.firstChild);
	}

	function render() {
		try {
			injectStyle();
			document.querySelectorAll(CARD_SELECTOR).forEach(function (card) {
				var id = card.getAttribute('data-id');
				var flag = cache[id];
				if (!flag) return;
				appendCardIndicator(card, flag);
			});

			var m = (location.hash || '').match(/[?&]id=([a-f0-9]{32})/i);
			if (m && cache[m[1]]) {
				renderDetailBanner(cache[m[1]]);
			}
		} catch (e) {}
	}

	function tick() {
		var ids = extractIds();
		if (!ids.length) return;
		fetchFlags(ids, render);
	}

	try {
		var obs = new MutationObserver(function () {
			window.clearTimeout(tick._t);
			tick._t = window.setTimeout(tick, 250);
		});
		obs.observe(document.body, { childList: true, subtree: true });
		window.addEventListener('hashchange', tick);
		tick();
	} catch (e) {}
})();
