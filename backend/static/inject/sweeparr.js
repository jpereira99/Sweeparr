/**
 * Sweeparr Jellyfin web-client injection (§8.2) — default variant.
 *
 * Add this to Jellyfin via Dashboard → General → Custom CSS is not enough;
 * use the "custom JavaScript" index.html injection or a small plugin that
 * loads this file from:  {sweeparr}/static/inject/sweeparr.js
 *
 * It observes SPA navigation, batches item ids to the public /flags endpoint,
 * and renders "Leaving <date>" badges on cards + a banner with a
 * "Request to keep" deep-link on detail pages.
 *
 * Doctrine: it must fail SILENTLY and COMPLETELY. A broken selector across a
 * Jellyfin release must never break playback UI.
 */
(function () {
	'use strict';

	// Point this at your Sweeparr origin (through the Cloudflare Tunnel).
	var SWEEPARR_ORIGIN = (window.SWEEPARR_ORIGIN || '').replace(/\/$/, '');
	if (!SWEEPARR_ORIGIN) {
		// Best-effort: same host, assume reverse-proxied. Users can override.
		SWEEPARR_ORIGIN = '';
	}

	var cache = {};
	var STYLE_ID = 'sweeparr-style';
	var CARD_SELECTOR = '.card[data-id]';

	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		var css =
			'.swp-indicator{display:inline-flex;align-items:center;font:600 10px/1.2 sans-serif;' +
			'color:#fff;background:#E5484D;border-radius:4px;padding:3px 6px;pointer-events:none;' +
			'white-space:nowrap}' +
			'.swp-indicator--ribbon{position:absolute;left:0;top:0;z-index:2;margin:0;' +
			'font-weight:700;text-shadow:none}' +
			'.swp-banner{display:flex;gap:12px;align-items:center;margin:0 0 12px;padding:10px 14px;' +
			'border:1px solid rgba(229,72,77,.4);background:rgba(229,72,77,.12);border-radius:8px;' +
			'color:#FF7B80;font:500 13px/1.4 sans-serif}' +
			'.swp-banner button.swp-keep-btn{margin-left:auto;white-space:nowrap;border:0;border-radius:8px;' +
			'padding:8px 12px;font:600 13px/1 sans-serif;cursor:pointer;color:#0d1f16;' +
			'background:#5FC08D}' +
			'.swp-modal-backdrop{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;' +
			'justify-content:center;padding:16px;background:rgba(0,0,0,.72);backdrop-filter:blur(2px)}' +
			'.swp-modal{position:relative;width:100%;max-width:320px;max-height:min(90vh,560px);overflow:hidden;' +
			'border:1px solid rgba(255,255,255,.1);border-radius:14px;background:#161616;color:#f2f2f2;' +
			'font:500 13px/1.45 sans-serif;box-shadow:0 18px 48px rgba(0,0,0,.45)}' +
			'.swp-modal *,.swp-modal *::before,.swp-modal *::after{box-sizing:border-box}' +
			'.swp-modal__close{position:absolute;top:8px;right:8px;z-index:1;border:0;background:transparent;' +
			'color:#888;font:22px/1 sans-serif;cursor:pointer;padding:6px 8px;line-height:1}' +
			'.swp-modal__body{padding:18px 18px 20px}' +
			'.swp-modal__title{margin:0 28px 2px 0;font:600 15px/1.3 sans-serif;color:#fff}' +
			'.swp-modal__size{margin:0 0 10px;font:600 10.5px/1.2 monospace;color:#9a9a9a}' +
			'.swp-modal__badge{display:inline-flex;align-items:center;gap:4px;margin:0 0 10px;padding:4px 10px;border-radius:999px;' +
			'border:1px solid rgba(229,72,77,.4);background:rgba(229,72,77,.14);' +
			'font:600 10.5px/1 sans-serif;color:#FF7B80;text-transform:uppercase;letter-spacing:.02em}' +
			'.swp-modal__reason{margin:0;font:12px/1.45 sans-serif;color:#b8b8b8}' +
			'.swp-modal__rule{height:1px;margin:12px 0;background:rgba(255,255,255,.08)}' +
			'.swp-modal__label{display:block;margin:0 0 6px;font:11px/1.3 sans-serif;color:#7a7a7a}' +
			'.swp-modal__meta{margin:0;font:12px/1.45 sans-serif;color:#b8b8b8}' +
			'.swp-modal__title+.swp-modal__meta{margin-top:8px}' +
			'.swp-modal__note{display:block;width:100%;min-height:64px;margin:0 0 12px;padding:10px;border-radius:8px;' +
			'border:1px solid #333;background:#101010;color:#f2f2f2;font:12px/1.4 sans-serif;resize:none;outline:none}' +
			'.swp-modal__note:focus{border-color:#5FC08D}' +
			'.swp-modal__submit{display:block;width:100%;border:1px solid rgba(95,192,141,.5);border-radius:10px;padding:12px;' +
			'font:600 14px/1 sans-serif;cursor:pointer;color:#5FC08D;background:rgba(95,192,141,.18)}' +
			'.swp-modal__submit:disabled{opacity:.65;cursor:wait}' +
			'.swp-modal__delay{margin-bottom:10px;border-color:rgba(229,72,77,.5);color:#FF7B80;' +
			'background:rgba(229,72,77,.16)}' +
			'.swp-modal__hint{margin:12px 0 0;font:11px/1.4 sans-serif;color:#777;text-align:center}' +
			'.swp-modal__ok{display:flex;align-items:center;justify-content:center;width:44px;height:44px;' +
			'margin:8px auto 12px;border-radius:999px;border:1px solid rgba(95,192,141,.45);' +
			'background:rgba(95,192,141,.16);color:#5FC08D;font:20px/1 sans-serif}';
		var el = document.createElement('style');
		el.id = STYLE_ID;
		el.textContent = css;
		(document.head || document.documentElement).appendChild(el);
	}

	function extractIds() {
		var ids = {};
		try {
			// Detail page id from the URL hash (?id=...).
			var m = (location.hash || '').match(/[?&]id=([a-f0-9]{32})/i);
			if (m) ids[m[1]] = true;
			// Card grid: Jellyfin scopes item cards as .card[data-id].
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
			'<div class="swp-modal" role="dialog" aria-modal="true" aria-label="Request to keep">' +
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
					renderKeepModalBody(
						modal,
						'<p class="swp-modal__meta">This link has expired or the item is no longer leaving.</p>'
					);
					return;
				}
				if (data.status !== 'pending' || data.id) {
					renderKeepModalBody(
						modal,
						'<div class="swp-modal__ok">✓</div>' +
							'<p class="swp-modal__title">Request already sent</p>' +
							'<p class="swp-modal__meta">' +
							keepTitle(data) +
							' stays put until an admin decides. Deletion is paused while your request is pending.</p>'
					);
					return;
				}

				var canKeep = !!data.allow_keep;
				var canDelay = !!data.allow_delay;
				var actionsHtml = '';
				if (canDelay) {
					actionsHtml +=
						'<button type="button" class="swp-modal__submit swp-modal__delay">⏱ Delay ' +
						(data.delay_days || 0) +
						' days</button>';
				}
				if (canKeep) {
					actionsHtml +=
						'<button type="button" class="swp-modal__submit swp-modal__keep">✓ Request to keep</button>';
				}
				if (!canKeep && !canDelay) {
					actionsHtml +=
						'<p class="swp-modal__meta">Reach out to your admin to keep this item.</p>';
				}

				renderKeepModalBody(
					modal,
					'<p class="swp-modal__title">' +
						keepTitle(data) +
						'</p>' +
						(data.size_gb != null
							? '<p class="swp-modal__size">' + data.size_gb + ' GB</p>'
							: '') +
						'<span class="swp-modal__badge">⏱ Leaves ' +
						fmt(data.delete_at) +
						'</span>' +
						'<p class="swp-modal__reason">Why: ' +
						(data.reason_public || '') +
						'</p>' +
						'<div class="swp-modal__rule"></div>' +
						(canKeep || canDelay
							? '<label class="swp-modal__label">Add a note (optional)</label>' +
								'<textarea class="swp-modal__note"></textarea>'
							: '') +
						actionsHtml
				);

				var noteEl = modal.querySelector('.swp-modal__note');
				var keepBtn = modal.querySelector('.swp-modal__keep');
				var delayBtn = modal.querySelector('.swp-modal__delay');

				function note() {
					return noteEl ? noteEl.value : '';
				}

				if (keepBtn) {
					keepBtn.addEventListener('click', function (e) {
						e.preventDefault();
						e.stopPropagation();
						keepBtn.disabled = true;
						if (delayBtn) delayBtn.disabled = true;
						keepBtn.textContent = 'Sending…';
						fetch(SWEEPARR_ORIGIN + '/api/v1/keep/' + encodeURIComponent(token), {
							method: 'POST',
							credentials: 'omit',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ reason: note() }),
						})
							.then(function (r) {
								return r.ok ? r.json() : null;
							})
							.then(function (result) {
								if (!result) {
									keepBtn.disabled = false;
									if (delayBtn) delayBtn.disabled = false;
									keepBtn.textContent = '✓ Request to keep';
									return;
								}
								renderKeepModalBody(
									modal,
									'<div class="swp-modal__ok">✓</div>' +
										'<p class="swp-modal__title">Request sent</p>' +
										'<p class="swp-modal__meta">' +
										keepTitle(result) +
										' stays put until an admin decides. Deletion is paused while your request is pending.</p>' +
										'<p class="swp-modal__hint">Close this to return to Jellyfin.</p>'
								);
							})
							.catch(function () {
								keepBtn.disabled = false;
								if (delayBtn) delayBtn.disabled = false;
								keepBtn.textContent = '✓ Request to keep';
							});
					});
				}

				if (delayBtn) {
					delayBtn.addEventListener('click', function (e) {
						e.preventDefault();
						e.stopPropagation();
						delayBtn.disabled = true;
						if (keepBtn) keepBtn.disabled = true;
						delayBtn.textContent = 'Delaying…';
						fetch(SWEEPARR_ORIGIN + '/api/v1/delay/' + encodeURIComponent(token), {
							method: 'POST',
							credentials: 'omit',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ reason: note() }),
						})
							.then(function (r) {
								return r.ok ? r.json() : null;
							})
							.then(function (result) {
								if (!result) {
									delayBtn.disabled = false;
									if (keepBtn) keepBtn.disabled = false;
									delayBtn.textContent = '⏱ Delay ' + (data.delay_days || 0) + ' days';
									return;
								}
								if (result.capped) {
									renderKeepModalBody(
										modal,
										'<p class="swp-modal__title">No delays left</p>' +
											'<p class="swp-modal__meta">You have used all available delays for ' +
											keepTitle(data) +
											'.</p>'
									);
									return;
								}
								var remaining = result.delay_remaining || 0;
								renderKeepModalBody(
									modal,
									'<div class="swp-modal__ok">⏱</div>' +
										'<p class="swp-modal__title">Removal delayed</p>' +
										'<p class="swp-modal__meta">' +
										keepTitle(data) +
										' now leaves ' +
										fmt(result.delete_at) +
										'. ' +
										(remaining > 0
											? 'You can delay ' + remaining + ' more time' + (remaining === 1 ? '' : 's') + '.'
											: 'You have used all available delays.') +
										'</p>' +
										'<p class="swp-modal__hint">Close this to return to Jellyfin.</p>'
								);
							})
							.catch(function () {
								delayBtn.disabled = false;
								if (keepBtn) keepBtn.disabled = false;
								delayBtn.textContent = '⏱ Delay ' + (data.delay_days || 0) + ' days';
							});
					});
				}
			})
			.catch(function () {
				renderKeepModalBody(
					modal,
					'<p class="swp-modal__meta">Could not reach Sweeparr. Check that it is running and reachable.</p>'
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
		text.textContent =
			'Leaving ' + fmt(flag.delete_at) + ' — ' + (flag.reason_public || '');
		var btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'swp-keep-btn';
		btn.textContent = 'Request to keep';
		btn.addEventListener(
			'click',
			function (e) {
				e.preventDefault();
				e.stopPropagation();
				openKeepModal(flag);
			},
			true
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
