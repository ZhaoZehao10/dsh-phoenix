(function () {
	try {
		if (window.__P282_UI_GUARD__) return;
		window.__P282_UI_GUARD__ = true;
		try { console.warn('[P-282-UI] guard active @ ' + String((window.location && window.location.href) || '').slice(0, 90)); } catch (e) {}
		var SNAP_KEY = '__P282_UI_SNAPSHOT__';
		var STORE = (function () {
			try { var ls = window.localStorage; ls.setItem('__p282_probe__', '1'); ls.removeItem('__p282_probe__'); return ls; } catch (e) {}
			try { return window.sessionStorage; } catch (e) {}
			return null;
		})();
		var FRESH_MS = 10000;           // 仅恢复"崩溃前 10 秒内"的快照
		var HEAP_WARN_RATIO = 0.8;      // 堆水位预警阈值

		function indexOf(el) {
			var i = 0, s = el;
			while ((s = s.previousElementSibling)) i++;
			return i;
		}
		function pathOf(el) {
			var parts = [], n = el;
			while (n && n.nodeType === 1 && parts.length < 8) {
				parts.unshift(indexOf(n) + ':' + (n.tagName || '').toLowerCase());
				n = n.parentElement;
			}
			return parts.join('/');
		}
		function findByPath(path) {
			try {
				var parts = String(path).split('/');
				var n = document;
				for (var i = 0; i < parts.length; i++) {
					var p = parts[i].split(':');
					var idx = parseInt(p[0], 10);
					if (!n || !n.children || idx >= n.children.length) return null;
					n = n.children[idx];
				}
				return n;
			} catch (e) { return null; }
		}
		function setValue(el, value) {
			try {
				if (el.isContentEditable) {
					el.innerText = value;
					el.dispatchEvent(new Event('input', { bubbles: true }));
					return;
				}
				var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
				var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
				setter.call(el, value);
				el.dispatchEvent(new Event('input', { bubbles: true }));
			} catch (e) {}
		}
		function scrollables() {
			var out = [];
			try {
				var all = document.querySelectorAll('*');
				for (var i = 0; i < all.length && out.length < 40; i++) {
					var e = all[i];
					try {
						var cs = typeof getComputedStyle === 'function' ? getComputedStyle(e) : null;
						if (!cs || !/(auto|scroll|overlay)/.test(String(cs.overflowY || ''))) continue;
						if (e.scrollHeight > e.clientHeight + 20 && e.clientHeight > 50) out.push(e);
					} catch (e2) {}
				}
			} catch (e) {}
			return out;
		}
		function mainScroller() {
			var best = null, bestRange = 0;
			scrollables().forEach(function (e) {
				var r = e.scrollHeight - e.clientHeight;
				if (r > bestRange) { bestRange = r; best = e; }
			});
			return best;
		}
		function capture() {
			var snap = { t: Date.now(), main: null, fields: [] };
			try {
				var ms = mainScroller();
				if (ms) snap.main = { y: ms.scrollTop, h: ms.scrollHeight, ch: ms.clientHeight };
			} catch (e) {}
			try {
				var nodes = document.querySelectorAll('textarea, input[type=text], input[type=search], [contenteditable=true]');
				for (var i = 0; i < nodes.length && snap.fields.length < 50; i++) {
					var el = nodes[i];
					var v = el.isContentEditable ? el.innerText : el.value;
					if (typeof v === 'string' && v.length > 0 && v.length < 20000) {
						snap.fields.push({ p: pathOf(el), v: v, ce: !!el.isContentEditable });
					}
				}
			} catch (e) {}
			return snap;
		}
		function restoreFields(snap) {
			try {
				(snap.fields || []).forEach(function (f) {
					var el = findByPath(f.p);
					if (el) setValue(el, f.v);
				});
			} catch (e) {}
		}
		function restoreScroll(snap) {
			try {
				if (!snap.main) return;
				var deadline = Date.now() + 10000;
				var ticks = 0;
				var tick = function () {
					try {
						var ms = mainScroller();
						if (ms) {
							var range = Math.max(1, ms.scrollHeight - ms.clientHeight);
							var oldRange = Math.max(1, snap.main.h - snap.main.ch);
							var target = Math.round(snap.main.y * (range / oldRange));
							if (Math.abs(ms.scrollTop - target) > 2) ms.scrollTop = target;
							if (ticks === 0 || Math.abs(ms.scrollTop - target) > 2) {
								console.warn('[P-282-UI] scroll restore target=' + target + ' actual=' + Math.round(ms.scrollTop) + ' h=' + ms.scrollHeight);
							}
						}
					} catch (e) {}
					ticks++;
					if (Date.now() < deadline) setTimeout(tick, 300);
				};
				tick();
			} catch (e) {}
		}

		// ① 每 2 秒自动快照（首次记录诊断）
		var __p282SnapLogged = false;
		setInterval(function () {
			try {
				var __snap = capture();
				STORE && STORE.setItem(SNAP_KEY, JSON.stringify(__snap));
				if (!__p282SnapLogged) { __p282SnapLogged = true; console.warn('[P-282-UI] snapshot first main=' + (__snap.main ? Math.round(__snap.main.y) + '/' + __snap.main.h : 'none') + ' fields=' + __snap.fields.length); }
			} catch (e) {}
		}, 2000);

		// ② 崩溃重载后：新快照 ⟹ 恢复（草稿立即恢复；滚动持续校正 10 秒）
		try {
			var raw = STORE ? STORE.getItem(SNAP_KEY) : null;
			if (!raw) {
				console.warn('[P-282-UI] restore skipped: empty');
			} else {
				var snap = JSON.parse(raw);
				var age = snap && typeof snap.t === 'number' ? Date.now() - snap.t : -1;
				if (snap && age >= 0 && age < FRESH_MS) {
					console.warn('[P-282-UI] restore begin age=' + age + 'ms main=' + (snap.main ? Math.round(snap.main.y) + '/' + snap.main.h : 'none') + ' fields=' + ((snap.fields || []).length));
					restoreFields(snap);
					setTimeout(function () { try { restoreFields(snap); } catch (e) {} }, 1200);
					restoreScroll(snap);
				} else {
					console.warn('[P-282-UI] restore skipped: stale age=' + age + 'ms');
				}
			}
		} catch (e) {}

		// ③ 堆水位预警
		setInterval(function () {
			try {
				var m = performance.memory;
				if (!m || !m.jsHeapSizeLimit) return;
				var ratio = m.usedJSHeapSize / m.jsHeapSizeLimit;
				if (ratio > HEAP_WARN_RATIO) {
					console.warn('[P-282-MEM] ' + Math.round(ratio * 100) + '% (' + Math.round(m.usedJSHeapSize / 1048576) + 'MB / ' + Math.round(m.jsHeapSizeLimit / 1048576) + 'MB)');
				}
			} catch (e) {}
		}, 30000);
	} catch (e) {}
})();
