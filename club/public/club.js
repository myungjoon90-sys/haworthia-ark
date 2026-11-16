// 하월시아 클럽 — 화면 동작 (좋아요·댓글·사진 올리기·# 자동완성·로그인·운영자)
(function () {
  var B = document.documentElement.getAttribute('data-b') || '';
  var LOGGED = document.documentElement.getAttribute('data-me') === '1';

  // 화면 언어 (서버가 window.CLUB_I18N 에 번역을 넣어 줌. 없으면 한국어 그대로)
  var I18 = window.CLUB_I18N || {};
  function L(s, v) { var o = I18[s] || s; if (v) o = o.replace(/\{(\w+)\}/g, function (m, k) { return v[k] !== undefined ? v[k] : m; }); return o; }
  function $(s, el) { return (el || document).querySelector(s); }
  function $$(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  function toast(msg) {
    var t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('on');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }
  window.clubToast = toast;
  function api(url, body) {
    return fetch(B + url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}), credentials: 'same-origin',
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: L('서버 응답 오류') }; }); });
  }
  window.clubApi = api;
  function needLogin() {
    if (LOGGED) return false;
    location.href = B + '/login?next=' + encodeURIComponent(location.pathname + location.search);
    return true;
  }

  // ---- 사진 넘기기 점 ----
  function bindStrips(root) {
    $$('.ph .strip', root).forEach(function (st) {
      if (st._b) return; st._b = 1;
      var dots = $$('.dots i', st.parentNode);
      if (dots.length < 2) return;
      st.addEventListener('scroll', function () {
        var i = Math.round(st.scrollLeft / st.clientWidth);
        dots.forEach(function (d, j) { d.classList.toggle('on', j === i); });
      }, { passive: true });
    });
  }

  // ---- 좋아요 ----
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-like]');
    if (!b) return;
    e.preventDefault();
    if (needLogin()) return;
    var id = b.getAttribute('data-like');
    api('/api/posts/' + id + '/like').then(function (r) {
      if (!r.ok) return toast(r.error);
      $$('[data-like="' + id + '"]').forEach(function (x) {
        x.classList.toggle('liked', r.liked);
        var h = $('.heart', x); if (h) h.textContent = r.liked ? '♥' : '♡';
        var n = $('.n', x); if (n) n.textContent = r.n;
        if (r.liked) { x.classList.add('pop'); setTimeout(function () { x.classList.remove('pop'); }, 220); }
      });
    });
  });
  // 사진 두 번 누르면 좋아요
  document.addEventListener('dblclick', function (e) {
    var ph = e.target.closest('.ph[data-post]');
    if (!ph) return;
    var b = $('[data-like="' + ph.getAttribute('data-post') + '"]');
    if (b && !b.classList.contains('liked')) b.click();
  });

  // ---- 공유 ----
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-share]');
    if (!b) return;
    e.preventDefault();
    var url = location.origin + b.getAttribute('data-share');
    if (navigator.share) navigator.share({ title: '하월시아 클럽', url: url }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast(L('주소를 복사했습니다.')); });
  });

  // ---- … 메뉴 ----
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-menu]');
    if (b) {
      e.preventDefault();
      var sh = $('#sheet-' + b.getAttribute('data-menu'));
      if (sh) sh.classList.add('on');
      return;
    }
    if (e.target.classList && e.target.classList.contains('sheet')) e.target.classList.remove('on');
    var c = e.target.closest('[data-close]');
    if (c) { var s = c.closest('.sheet'); if (s) s.classList.remove('on'); }
  });

  // ---- 일반 동작 버튼 (data-act="주소" data-body='{"a":1}' data-confirm="…" data-go="이동할 곳") ----
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    e.preventDefault();
    if (b.hasAttribute('data-login') && needLogin()) return;
    var cf = b.getAttribute('data-confirm');
    if (cf && !confirm(cf)) return;
    var body = {};
    try { body = JSON.parse(b.getAttribute('data-body') || '{}'); } catch (x) {}
    var ask = b.getAttribute('data-prompt');
    if (ask) { var v = prompt(ask, b.getAttribute('data-prompt-value') || ''); if (v === null) return; body[b.getAttribute('data-prompt-key') || 'value'] = v; }
    b.disabled = true;
    api(b.getAttribute('data-act'), body).then(function (r) {
      b.disabled = false;
      if (!r.ok) return toast(r.error || L('실패했습니다.'));
      if (b.getAttribute('data-done')) toast(b.getAttribute('data-done'));
      var go = b.getAttribute('data-go');
      if (go === 'reload') setTimeout(function () { location.reload(); }, 350);
      else if (go === 'back') setTimeout(function () { history.length > 1 ? history.back() : (location.href = B + '/'); }, 350);
      else if (go) setTimeout(function () { location.href = go.indexOf('/') === 0 ? B + go : go; }, 350);
      else if (r.url) setTimeout(function () { location.href = r.url; }, 350);
    });
  });

  // ---- 댓글 ----
  var cf = $('#cform');
  if (cf && !LOGGED) $('input', cf).addEventListener('click', needLogin);
  if (cf) cf.addEventListener('submit', function (e) {
    e.preventDefault();
    if (needLogin()) return;
    var inp = $('input', cf); var v = inp.value.trim();
    if (!v) return;
    var btn = $('button', cf); btn.disabled = true;
    api('/api/posts/' + cf.getAttribute('data-post') + '/comments', { body: v }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) return toast(r.error);
      location.reload();
    });
  });

  // ---- 사진 벽돌판: 짧은 줄에 차례로 넣기 (사진 비율을 미리 알아서 화면이 덜 흔들림) ----
  function masonry(el) {
    if (el._m) return;
    var n = window.innerWidth >= 700 ? 3 : 2;
    var pins = $$('.pin', el);
    el.innerHTML = ''; el.classList.add('mjs');
    var cols = [];
    for (var i = 0; i < n; i++) { var c = document.createElement('div'); c.className = 'mcol'; el.appendChild(c); cols.push({ el: c, h: 0 }); }
    el._m = { cols: cols };
    masonryAdd(el, pins);
  }
  function masonryAdd(el, pins) {
    pins.forEach(function (p) {
      var ar = parseFloat(p.getAttribute('data-ar')) || 1;
      var c = el._m.cols.reduce(function (a, b) { return b.h < a.h ? b : a; });
      c.el.appendChild(p); c.h += ar + 0.3;
    });
  }
  $$('.masonry').forEach(masonry);

  // ---- 더 보기 ----
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-more]');
    if (!b) return;
    e.preventDefault();
    b.disabled = true; b.textContent = L('불러오는 중…');
    fetch(b.getAttribute('data-more'), { credentials: 'same-origin' }).then(function (r) { return r.text(); }).then(function (html) {
      var tmp = document.createElement('div'); tmp.innerHTML = html;
      var target = document.getElementById(b.getAttribute('data-target'));
      var nb = tmp.querySelector('[data-more]');
      $$('[data-more]', tmp).forEach(function (x) { x.parentNode.removeChild(x); });
      var holder = tmp.querySelector('.grid') || tmp;
      if (target._m) masonryAdd(target, $$('.pin', holder));
      else while (holder.firstChild) target.appendChild(holder.firstChild);
      bindStrips(target);
      if (nb) { b.setAttribute('data-more', nb.getAttribute('data-more')); b.disabled = false; b.textContent = L('더 보기'); }
      else b.parentNode.removeChild(b);
    });
  });

  // =============================================================
  // # 자동완성 (글쓰기 칸)
  // =============================================================
  function bindTagInput(ta) {
    var box = document.createElement('div'); box.className = 'ac';
    ta.parentNode.appendChild(box);
    var items = [], sel = 0, tok = null, timer = null, seq = 0;
    function current() {
      var pos = ta.selectionStart, txt = ta.value.slice(0, pos);
      var m = /#([\p{L}\p{N}_]*)$/u.exec(txt);
      return m ? { start: pos - m[0].length, end: pos, q: m[1] } : null;
    }
    function hide() { box.style.display = 'none'; items = []; }
    function render() {
      if (!items.length) return hide();
      box.innerHTML = items.map(function (it, i) {
        return '<div data-i="' + i + '" class="' + (i === sel ? 'on' : '') + '"><b>#' + esc(it.word) + '</b>' +
          '<small>' + (it.fresh ? L('새 태그로 쓰기') : it.n ? L('{n}개 글', { n: it.n }) : L('품종명')) + '</small></div>';
      }).join('');
      box.style.display = 'block';
    }
    function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function pick(i) {
      var it = items[i]; if (!it || !tok) return;
      var v = ta.value;
      ta.value = v.slice(0, tok.start) + '#' + it.word + ' ' + v.slice(tok.end);
      var p = tok.start + it.word.length + 2;
      ta.setSelectionRange(p, p); ta.focus(); hide();
      ta.dispatchEvent(new Event('input'));
    }
    function lookup() {
      tok = current();
      if (!tok) return hide();
      var my = ++seq, qv = tok.q;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fetch(B + '/api/tags?q=' + encodeURIComponent(qv), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (r) {
          if (my !== seq || !tok) return;
          items = (r.list || []).slice(0, 8);
          // 지금 치고 있는 글자 그대로도 고를 수 있게 (새 품종명)
          if (tok && tok.q && !items.some(function (x) { return x.key === tok.q.toLowerCase(); })) items.push({ word: tok.q, key: tok.q.toLowerCase(), n: 0, ark: false, fresh: true });
          sel = 0; render();
        }).catch(hide);
      }, 140);
    }
    ta.addEventListener('input', lookup);
    ta.addEventListener('click', lookup);
    ta.addEventListener('keydown', function (e) {
      if (box.style.display !== 'block') return;
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { pick(sel); e.preventDefault(); }
      else if (e.key === 'Escape') hide();
    });
    box.addEventListener('mousedown', function (e) { var d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); pick(+d.getAttribute('data-i')); } });
    ta.addEventListener('blur', function () { setTimeout(hide, 150); });
  }
  $$('textarea[data-tags]').forEach(bindTagInput);
  // 인기 태그 단추 → 글에 넣기
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-addtag]');
    if (!b) return;
    e.preventDefault();
    var ta = $('textarea[data-tags]'); if (!ta) return;
    var w = '#' + b.getAttribute('data-addtag');
    if (ta.value.indexOf(w) === -1) ta.value = (ta.value.replace(/\s+$/, '') + (ta.value.trim() ? ' ' : '') + w + ' ');
    ta.focus();
  });

  // =============================================================
  // 글쓰기 — 사진 줄여서 올리기
  // =============================================================
  var wf = $('#writeform');
  if (wf) {
    var shots = [];
    var thumbs = $('#thumbs');
    function drawThumbs() {
      thumbs.innerHTML = '';
      shots.forEach(function (s, i) {
        var d = document.createElement('div'); d.className = 't';
        d.innerHTML = '<img src="' + s.url + '" alt="">' + (i === 0 ? '<span class="one">' + L('대표') + '</span>' : '') + '<button type="button" aria-label="' + L('빼기') + '">✕</button>';
        d.querySelector('button').onclick = function () { URL.revokeObjectURL(s.url); shots.splice(i, 1); drawThumbs(); };
        thumbs.appendChild(d);
      });
      var c = $('#photocount'); if (c) c.textContent = shots.length ? L('{n}/10장', { n: shots.length }) : '';
    }
    function loadImg(file) {
      if (window.createImageBitmap) {
        return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return createImageBitmap(file); });
      }
      return new Promise(function (ok, no) { var im = new Image(); im.onload = function () { ok(im); }; im.onerror = no; im.src = URL.createObjectURL(file); });
    }
    function shrink(img, max, q) {
      var w = img.width, h = img.height, r = Math.min(1, max / Math.max(w, h));
      var c = document.createElement('canvas'); c.width = Math.round(w * r); c.height = Math.round(h * r);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return new Promise(function (ok) { c.toBlob(function (b) { ok({ blob: b, w: c.width, h: c.height }); }, 'image/jpeg', q); });
    }
    function addFiles(list) {
      var files = Array.prototype.slice.call(list || []);
      if (shots.length + files.length > 10) { toast(L('사진은 10장까지 올릴 수 있습니다.')); files = files.slice(0, 10 - shots.length); }
      var chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () {
          return loadImg(f).then(function (img) {
            return Promise.all([shrink(img, 1600, 0.86), shrink(img, 520, 0.8)]).then(function (r) {
              shots.push({ full: r[0].blob, thumb: r[1].blob, w: r[0].w, h: r[0].h, url: URL.createObjectURL(r[1].blob) });
              drawThumbs();
            });
          }).catch(function () {
            // 줄이기를 못 하는 사진(일부 HEIC 등)은 원본 그대로
            shots.push({ full: f, thumb: f, w: 0, h: 0, url: URL.createObjectURL(f) }); drawThumbs();
          });
        });
      });
    }
    $$('input[type=file]', wf).forEach(function (inp) {
      inp.addEventListener('change', function () { addFiles(inp.files); inp.value = ''; });
    });

    // 내 식물 고르기
    var plantId = wf.getAttribute('data-plant') || '';
    var newBox = $('#newplant');
    $$('.plpick button', wf).forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.plpick button', wf).forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        plantId = b.getAttribute('data-id');
        if (newBox) newBox.style.display = plantId === 'new' ? 'block' : 'none';
      });
    });

    // ---- 종 고르기: #품종이나 고른 식물로 자동, 손으로 누르면 그 뒤로는 손으로 고른 것 ----
    var spBox = $('#sppick');
    var spChoice = '', spManual = false, spMap = {};
    function tkey(x) { return String(x || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
    function spShow() { $$('#sppick button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-sp') === String(spChoice)); }); }
    function spAuto() {
      if (!spBox || spManual) return;
      var keys = [];
      var pb = $('.plpick button.on[data-tag]', wf); if (pb) keys.push(pb.getAttribute('data-tag'));
      if (plantId === 'new' && $('#newplantname')) keys.push(tkey($('#newplantname').value));
      var txt = $('#body').value, re = /#([\p{L}\p{N}_]{1,40})((?:[ \t]+[\p{L}\p{N}_]{1,20}){0,3})/gu, m;
      while ((m = re.exec(txt))) {
        var ws = m[2].trim() ? m[2].trim().split(/[ \t]+/) : [];
        for (var n = ws.length; n >= 0; n--) { var k = tkey(m[1] + ws.slice(0, n).join('')); if (spMap[k]) { keys.push(k); break; } if (n === 0) keys.push(tkey(m[1])); }
      }
      var found = '';
      for (var i = 0; i < keys.length; i++) if (keys[i] && spMap[keys[i]]) { found = spMap[keys[i]]; break; }
      spChoice = found ? String(found) : (keys.length ? 'etc' : '');
      spShow();
    }
    if (spBox) {
      try { spMap = JSON.parse(spBox.getAttribute('data-map') || '{}'); } catch (x) {}
      if (spBox.getAttribute('data-cur')) { spChoice = spBox.getAttribute('data-cur'); spManual = spBox.getAttribute('data-src') === 'user'; spShow(); }
      $$('#sppick button').forEach(function (b) { b.addEventListener('click', function () { spChoice = b.getAttribute('data-sp'); spManual = true; spShow(); }); });
      $('#body').addEventListener('input', spAuto);
      $$('.plpick button', wf).forEach(function (b) { b.addEventListener('click', function () { setTimeout(spAuto, 0); }); });
      if ($('#newplantname')) $('#newplantname').addEventListener('input', spAuto);
      if (!spBox.getAttribute('data-cur')) spAuto();
    }

    wf.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = $('#body').value.trim();
      var editId = wf.getAttribute('data-edit');
      var err = $('#werr'); err.style.display = 'none';
      var fd = new FormData();
      fd.append('body', body);
      fd.append('species', spChoice || ''); fd.append('species_pick', spManual ? 'user' : 'auto');
      if (plantId === 'new') {
        var nm = $('#newplantname').value.trim();
        if (!nm) { err.textContent = L('새 식물 이름을 적어 주세요.'); err.style.display = 'block'; return; }
        fd.append('new_plant', nm);
      } else if (plantId) fd.append('plant_id', plantId);
      var btn = $('#wsubmit'); btn.disabled = true;
      if (editId) {
        var o = { body: body, species: spChoice || '', species_pick: spManual ? 'user' : 'auto' }; if (plantId === 'new') o.new_plant = $('#newplantname').value.trim(); else if (plantId) o.plant_id = plantId;
        btn.textContent = L('저장하는 중…');
        api('/api/posts/' + editId + '/edit', o).then(function (r) {
          if (!r.ok) { btn.disabled = false; btn.textContent = L('저장하기'); err.textContent = r.error; err.style.display = 'block'; return; }
          location.href = r.url;
        });
        return;
      }
      if (!shots.length && !body) { btn.disabled = false; err.textContent = L('사진이나 글을 넣어 주세요.'); err.style.display = 'block'; return; }
      shots.forEach(function (s, i) {
        fd.append('f' + i, s.full, 'p' + i + '.jpg');
        fd.append('t' + i, s.thumb, 't' + i + '.jpg');
        fd.append('w' + i, s.w); fd.append('h' + i, s.h);
      });
      var xhr = new XMLHttpRequest();
      xhr.open('POST', B + '/api/posts');
      xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) btn.textContent = L('올리는 중… {p}%', { p: Math.round(ev.loaded / ev.total * 100) }); };
      xhr.onload = function () {
        var r = {}; try { r = JSON.parse(xhr.responseText); } catch (x) { r = { ok: false, error: L('서버 응답 오류') }; }
        if (!r.ok) { btn.disabled = false; btn.textContent = L('올리기'); err.textContent = r.error; err.style.display = 'block'; return; }
        location.href = r.url;
      };
      xhr.onerror = function () { btn.disabled = false; btn.textContent = L('올리기'); err.textContent = L('인터넷 연결을 확인해 주세요.'); err.style.display = 'block'; };
      btn.textContent = L('올리는 중…');
      xhr.send(fd);
    });
  }

  // =============================================================
  // 로그인 (번호 → 인증번호 → 처음이면 닉네임)
  // =============================================================
  var lg = $('#login');
  if (lg) {
    var next = lg.getAttribute('data-next') || (B + '/');
    var phone = '', signup = '';
    var e1 = $('#lerr');
    function show(step) { $$('[data-step]', lg).forEach(function (x) { x.style.display = x.getAttribute('data-step') === step ? 'block' : 'none'; }); }
    function bad(m) { e1.textContent = m; e1.style.display = 'block'; }
    function good() { e1.style.display = 'none'; }
    var cty = $('#country');
    function country() { return cty ? (cty.value || '82') : '82'; }
    if (cty) cty.onchange = function () {
      var h = $('#intlhint'); if (h) h.style.display = cty.value === '82' ? 'none' : 'block';
      $('#phone').placeholder = cty.value === '82' ? '010-1234-5678' : L('휴대폰 번호');
    };
    $('#sendbtn').onclick = function () {
      phone = $('#phone').value; good();
      if (cty && !cty.value) return bad(L('나라를 먼저 골라 주세요.'));
      var b = this; b.disabled = true; b.textContent = L('보내는 중…');
      api('/api/auth/send', { phone: phone, country: country() }).then(function (r) {
        b.disabled = false; b.textContent = L('인증번호 받기');
        if (!r.ok) return bad(r.error);
        show('code'); $('#code').focus();
        $('#sentto').textContent = r.sent_to || ((country() === '82' ? '' : '+' + country() + ' ') + phone);
        if (r.dev_code) { $('#code').value = r.dev_code; toast(L('시험 모드: 인증번호 {code}', { code: r.dev_code })); }
      });
    };
    $('#resend').onclick = function (e) { e.preventDefault(); show('phone'); };
    $('#codebtn').onclick = function () {
      good(); var b = this; b.disabled = true;
      api('/api/auth/verify', { phone: phone, country: country(), code: $('#code').value }).then(function (r) {
        b.disabled = false;
        if (!r.ok) return bad(r.error);
        if (r.signup) { signup = r.signup; show('nick'); $('#nick').focus(); return; }
        location.href = next;
      });
    };
    $('#nickbtn').onclick = function () {
      good(); var b = this; b.disabled = true;
      api('/api/auth/signup', { signup: signup, nick: $('#nick').value, agree: $('#agree').checked }).then(function (r) {
        b.disabled = false;
        if (!r.ok) return bad(r.error);
        if (r.ark) toast(L('방주 멤버로 확인되었습니다 ✦'));
        setTimeout(function () { location.href = next; }, r.ark ? 900 : 0);
      });
    };
    ['phone', 'code', 'nick'].forEach(function (id) {
      var el = $('#' + id); if (!el) return;
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('#' + (id === 'phone' ? 'sendbtn' : id === 'code' ? 'codebtn' : 'nickbtn')).click(); } });
    });
  }

  // ---- 보증서 연결 ----
  var cform = $('#certform');
  if (cform) cform.addEventListener('submit', function (e) {
    e.preventDefault();
    var b = $('button', cform); b.disabled = true; b.textContent = L('보증서 확인 중…');
    api('/api/plants/' + cform.getAttribute('data-plant') + '/cert', { input: $('#certinput').value }).then(function (r) {
      b.disabled = false; b.textContent = L('보증서 연결하기');
      if (!r.ok) return toast(r.error);
      toast(r.status === 'ok' ? L('🛡 정품으로 연결되었습니다 ({how})', { how: L(r.how) }) : L('연결 신청이 접수되었습니다. 운영자 확인 후 🛡 배지가 붙습니다.'));
      setTimeout(function () { location.reload(); }, 1100);
    });
  });

  // ---- 홈 화면에 설치 ----
  var deferred = null;
  var bar = $('#install');
  function dismissed() { try { return localStorage.getItem('club_inst_x') === '1'; } catch (x) { return false; } }
  var standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    if (bar && !dismissed() && !standalone) bar.classList.add('on');
  });
  if (bar && !standalone && !dismissed() && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
    $('.how', bar).textContent = L('아래 공유 버튼 → 「홈 화면에 추가」');
    $('button.go', bar).style.display = 'none';
    bar.classList.add('on');
  }
  if (bar) {
    $('button.go', bar).onclick = function () { if (deferred) { deferred.prompt(); deferred = null; bar.classList.remove('on'); } };
    $('button.x', bar).onclick = function () { bar.classList.remove('on'); try { localStorage.setItem('club_inst_x', '1'); } catch (x) {} };
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(B + '/sw.js', { scope: B + '/' }).catch(function () {});

  bindStrips(document);
  // 성장일기 줄 — 지금 보는 글이 가운데 오도록 (세로 스크롤은 건드리지 않음)
  $$('.diary').forEach(function (d) {
    var st = $('.dstrip', d), cur = $('.ditem.cur', d);
    if (st && cur) st.scrollLeft = Math.max(0, cur.offsetLeft - st.offsetLeft - (st.clientWidth - cur.clientWidth) / 2);
  });
  // =============================================================
  // v29 — 팔로우 · 폰 알림 · 앱 아이콘 숫자 · 성장일기 공유 카드
  // =============================================================

  // ---- 팔로우 버튼 (온실 · 글 닉네임 옆 · 팔로워 목록) ----
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-follow]');
    if (!b) return;
    e.preventDefault();
    if (needLogin()) return;
    var on = !b.classList.contains('on');
    b.disabled = true;
    api('/api/follow', { nick: b.getAttribute('data-follow'), on: on }).then(function (r) {
      b.disabled = false;
      if (!r.ok) return toast(r.error || L('실패했습니다.'));
      if (b.classList.contains('fmini')) { b.textContent = L('팔로잉'); b.classList.add('on'); b.disabled = true; return; }
      b.classList.toggle('on', !!r.following);
      b.textContent = r.following ? L('팔로잉') : L('＋ 팔로우');
      var c = $('[data-fcount]'); if (c && b.closest('.follow-row')) c.textContent = r.followers;
    });
  });

  // ---- 앱 아이콘 숫자 (홈 화면에 놓은 클럽 아이콘에 안 읽은 알림 수) ----
  try {
    if (LOGGED && 'setAppBadge' in navigator) {
      var nb = $('.top .bell .nb'), n = nb ? parseInt(nb.textContent, 10) || 0 : 0;
      (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(function () {});
    }
  } catch (x) {}

  // ---- 폰 알림 켜기·끄기 (알림 화면) ----
  var pc = $('#pushcard');
  if (pc) (function () {
    var btn = $('[data-pb]', pc), title = $('[data-pt]', pc), sub = $('[data-ps]', pc);
    var key = pc.getAttribute('data-key');
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    function b64u(s) { var p = '='.repeat((4 - s.length % 4) % 4); var r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); var a = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) a[i] = r.charCodeAt(i); return a; }
    function show(state) {
      pc.classList.toggle('on', state === 'on');
      if (state === 'on') { title.textContent = L('폰 알림이 켜졌어요'); btn.textContent = L('끄기'); }
      else { btn.textContent = L('켜기'); }
    }
    if (!ok) {
      if (ios && !standalone) { $('#pushios').style.display = 'block'; btn.style.display = 'none'; }
      else { sub.textContent = L('이 폰은 알림을 지원하지 않아요'); btn.style.display = 'none'; }
      return;
    }
    if (ios && !standalone) { $('#pushios').style.display = 'block'; btn.style.display = 'none'; return; }
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (s) { show(s && Notification.permission === 'granted' ? 'on' : 'off'); }).catch(function () {});
    btn.onclick = function () {
      btn.disabled = true;
      navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.getSubscription().then(function (s) {
          if (s && pc.classList.contains('on')) {
            return s.unsubscribe().then(function () { return api('/api/push/unsub', { endpoint: s.endpoint }); }).then(function () { show('off'); toast(L('폰 알림을 껐어요')); });
          }
          btn.textContent = L('켜는 중…');
          return Notification.requestPermission().then(function (perm) {
            if (perm !== 'granted') { show('off'); toast(L('알림을 허용해야 받을 수 있어요. 폰 설정에서 허용해 주세요.')); return; }
            return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(key) }).then(function (ns) {
              return api('/api/push/sub', { sub: ns.toJSON() }).then(function (r) { if (!r.ok) { show('off'); return toast(r.error || L('실패했습니다.')); } show('on'); toast(L('폰 알림이 켜졌어요')); });
            });
          });
        });
      }).catch(function () { show('off'); toast(L('실패했습니다.')); }).then(function () { btn.disabled = false; });
    };
  })();

  // ---- 🎬 성장일기 공유 카드 (폰에서 그림으로 만든다 · 폰 글꼴 사용) ----
  var cbtn = $('#cardbtn'), cdata = $('#carddata');
  if (cbtn && cdata) (function () {
    var D; try { D = JSON.parse(cdata.textContent); } catch (x) { return; }
    var sheet = $('#csheet'), img = $('#cimg'), fmt = 'square', blob = null, busy = false;
    var SANS = '"Apple SD Gothic Neo","Noto Sans KR","Noto Sans CJK KR","Malgun Gothic","PingFang TC","PingFang SC","Microsoft JhengHei",sans-serif';
    var SERIF = '"Playfair Display",Georgia,"Times New Roman",serif';
    var G = '#1F4129', G2 = '#2D6A3E', GOLD = '#B8913F', GOLD2 = '#E2C27A', BG = '#F4F1E8', SUB = '#6b7368', INK = '#1d2a20';
    var cache = {};
    function load(src) {
      if (cache[src]) return cache[src];
      return (cache[src] = new Promise(function (ok, no) { var i = new Image(); i.onload = function () { ok(i); }; i.onerror = no; i.src = src; }));
    }
    function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
    function cover(c, im, x, y, w, h, r) {
      c.save(); rr(c, x, y, w, h, r); c.clip(); c.fillStyle = '#ddd'; c.fillRect(x, y, w, h);
      var s = Math.max(w / im.width, h / im.height), iw = im.width * s, ih = im.height * s;
      c.drawImage(im, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih); c.restore();
    }
    function pill(c, text, x, y, size, bg, fg, alignRight) {
      c.font = '800 ' + size + 'px ' + SANS; var w = c.measureText(text).width + size * 1.2, h = size * 1.7;
      var px = alignRight ? x - w : x; c.fillStyle = bg; rr(c, px, y, w, h, h / 2); c.fill();
      c.fillStyle = fg; c.textBaseline = 'middle'; c.fillText(text, px + size * 0.6, y + h / 2 + 1); c.textBaseline = 'alphabetic';
    }
    function logo(c, x, y, size, color) {
      c.fillStyle = color; c.font = '700 ' + size + 'px ' + SERIF; c.letterSpacing = (size * 0.14) + 'px';
      c.fillText('HAWORTHIA CLUB', x, y); c.font = '700 ' + Math.round(size * 0.42) + 'px ' + SERIF; c.letterSpacing = (size * 0.13) + 'px';
      c.fillStyle = GOLD; c.fillText('BY JIYANG', x, y + size * 0.75); c.letterSpacing = '0px';
    }
    function fit(c, text, maxW) { var t = String(text || ''); if (c.measureText(t).width <= maxW) return t; while (t.length > 1 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; }
    function dLabel(e) { return 'D+' + e.day; }
    function draw() {
      var size = fmt === 'story' ? [1080, 1920] : fmt === 'tl' ? [1080, 1350] : [1080, 1080];
      var cv = document.createElement('canvas'); cv.width = size[0]; cv.height = size[1];
      var c = cv.getContext('2d');
      var srcs = [D.first.src, D.last.src].concat(D.tl.map(function (e) { return e.src; }));
      return Promise.all(srcs.map(load).concat([load(D.qr), document.fonts && document.fonts.load ? document.fonts.load('700 40px "Playfair Display"').catch(function () {}) : null])).then(function (ims) {
        var A = ims[0], Z = ims[1], TL = ims.slice(2, 2 + D.tl.length), QR = ims[2 + D.tl.length];
        var tagTxt = '#' + D.tag;
        if (fmt === 'story') {
          c.fillStyle = BG; c.fillRect(0, 0, 1080, 1920);
          logo(c, 64, 118, 44, G);
          c.font = '800 62px ' + SANS; c.fillStyle = G2; c.fillText(fit(c, tagTxt, 950), 64, 268);
          c.fillStyle = INK; c.fillText(fit(c, D.L.days, 950), 64, 344);
          c.font = '500 30px ' + SANS; c.fillStyle = SUB; c.fillText('@' + D.nick + ' · ' + D.L.count, 64, 396);
          cover(c, A, 64, 440, 952, 600, 28); pill(c, dLabel(D.first), 88, 464, 34, 'rgba(31,65,41,.88)', '#fff'); pill(c, D.first.date, 88, 966, 24, 'rgba(255,255,255,.9)', INK);
          c.font = '800 38px ' + SANS; c.fillStyle = GOLD; c.textAlign = 'center'; c.fillText(D.L.after, 540, 1092); c.textAlign = 'left';
          cover(c, Z, 64, 1120, 952, 600, 28); pill(c, dLabel(D.last), 88, 1144, 34, GOLD, '#fff'); pill(c, D.last.date, 88, 1646, 24, 'rgba(255,255,255,.9)', INK);
          c.fillStyle = '#fff'; rr(c, 64, 1748, 952, 120, 26); c.fill();
          c.drawImage(QR, 84, 1758, 100, 100);
          c.fillStyle = INK; c.font = '800 32px ' + SANS; c.fillText(fit(c, D.L.foot, 780), 208, 1802);
          c.fillStyle = SUB; c.font = '500 26px ' + SANS; c.fillText(D.host, 208, 1844);
        } else if (fmt === 'tl') {
          c.fillStyle = G; c.fillRect(0, 0, 1080, 1350);
          logo(c, 60, 104, 34, '#fff');
          c.font = '800 50px ' + SANS; c.fillStyle = GOLD2; var tw = c.measureText(tagTxt).width;
          c.fillText(fit(c, tagTxt, 640), 60, 210); c.fillStyle = '#fff'; c.fillText(' ' + D.L.diary, 60 + Math.min(tw, 640), 210);
          var n = TL.length, top = 250, bottom = 1350 - 190, gap = 22, h = Math.min(300, Math.floor((bottom - top - gap * (n - 1)) / n)), w = Math.round(h * 4 / 3);
          TL.forEach(function (im, i) {
            var y = top + i * (h + gap), e = D.tl[i];
            cover(c, im, 60, y, w, h, 22);
            c.fillStyle = GOLD2; c.font = '800 44px ' + SANS; c.fillText(dLabel(e), 60 + w + 30, y + h / 2 - 14);
            c.fillStyle = 'rgba(255,255,255,.88)'; c.font = '500 28px ' + SANS; c.fillText(e.date, 60 + w + 30, y + h / 2 + 30);
            if (e.note) c.fillText(fit(c, e.note, 1080 - (60 + w + 30) - 50), 60 + w + 30, y + h / 2 + 68);
          });
          c.fillStyle = 'rgba(255,255,255,.9)'; c.font = '500 26px ' + SANS; c.fillText(fit(c, '@' + D.nick + ' · ' + D.host, 800), 60, 1300);
          c.fillStyle = '#fff'; rr(c, 920, 1180, 110, 110, 10); c.fill(); c.drawImage(QR, 925, 1185, 100, 100);
        } else {
          c.fillStyle = BG; c.fillRect(0, 0, 1080, 1080);
          logo(c, 54, 100, 36, G);
          c.font = '500 28px ' + SANS; c.fillStyle = SUB; c.textAlign = 'right'; c.fillText(fit(c, '@' + D.nick, 360), 1026, 110); c.textAlign = 'left';
          c.font = '800 46px ' + SANS; c.fillStyle = G2; var t1 = fit(c, tagTxt, 640); c.fillText(t1, 54, 210);
          var w1 = c.measureText(t1).width; c.fillStyle = INK; c.fillText(fit(c, ' · ' + D.L.change, 1026 - 54 - w1), 54 + w1, 210);
          cover(c, A, 54, 252, 452, 560, 28); pill(c, dLabel(D.first), 76, 274, 34, 'rgba(31,65,41,.88)', '#fff'); pill(c, D.first.date, 76, 762, 24, 'rgba(255,255,255,.9)', INK);
          c.fillStyle = GOLD; c.font = '900 40px ' + SANS; c.textAlign = 'center'; c.fillText('→', 540, 546); c.textAlign = 'left';
          cover(c, Z, 574, 252, 452, 560, 28); pill(c, dLabel(D.last), 596, 274, 34, GOLD, '#fff'); pill(c, D.last.date, 596, 762, 24, 'rgba(255,255,255,.9)', INK);
          c.fillStyle = SUB; c.font = '500 28px ' + SANS; c.fillText(fit(c, D.host + ' · ' + D.L.club, 760), 54, 950);
          c.drawImage(QR, 916, 860, 110, 110);
        }
        return new Promise(function (ok) { cv.toBlob(function (b) { ok(b); }, 'image/jpeg', 0.9); });
      });
    }
    function render() {
      if (busy) return; busy = true; blob = null;
      sheet.classList.add('wait');
      draw().then(function (b) {
        blob = b; if (img._u) URL.revokeObjectURL(img._u);
        img._u = URL.createObjectURL(b); img.src = img._u;
      }).catch(function () { toast(L('사진 만들기에 실패했어요')); }).then(function () { busy = false; sheet.classList.remove('wait'); });
    }
    function fileName() { return 'haworthia-' + String(D.tag).replace(/[^\w가-힣]/g, '') + '-D' + D.span + '-' + fmt + '.jpg'; }
    cbtn.onclick = function () { sheet.hidden = false; document.body.classList.add('noscroll'); if (!blob) render(); };
    $$('[data-close]', sheet).forEach(function (x) { x.onclick = function () { sheet.hidden = true; document.body.classList.remove('noscroll'); }; });
    $$('[data-fmt]', sheet).forEach(function (x) {
      x.onclick = function () { if (busy || fmt === x.getAttribute('data-fmt')) return; fmt = x.getAttribute('data-fmt'); $$('[data-fmt]', sheet).forEach(function (y) { y.classList.toggle('on', y === x); }); render(); };
    });
    $('#csave').onclick = function () {
      if (!blob) return;
      var a = document.createElement('a'); a.href = img._u; a.download = fileName(); document.body.appendChild(a); a.click(); a.remove();
      toast(L('사진을 저장했어요'));
    };
    $('#cshare').onclick = function () {
      if (!blob) return;
      var file = null;
      try { file = new File([blob], fileName(), { type: 'image/jpeg' }); } catch (x) {}
      var text = '#' + D.tag + ' ' + D.L.days + '\n' + D.url;
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], text: text }).catch(function () {});
      } else if (navigator.share) {
        navigator.share({ title: '#' + D.tag, text: text, url: D.url }).catch(function () {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(D.url).then(function () { toast(L('주소를 복사했어요')); });
      }
    };
    window.__clubCard = { draw: function (f) { fmt = f; return draw(); } }; // 시험용
  })();
})();
