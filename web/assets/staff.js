/**
 * Staff mobile waste-submission form.
 * Loads dropdown data from the backend (and caches it for offline use),
 * lets the person pick an item from a searchable list, then submits —
 * falling back to a local offline queue if the network is unavailable.
 */
(() => {
  const LOOKUPS_CACHE_KEY = 'wasteflow_lookups_cache';
  let lookups = null;
  let selectedItem = null;
  let costTouchedByUser = false;
  let photoBase64 = null, photoMime = null, photoName = null;
  let cart = []; // items added this session while logged in, pending one final "submit all"

  const $ = id => document.getElementById(id);
  const fmtMoney = n => 'AED ' + (Number(n) || 0).toFixed(2);

  function renderCart() {
    const session = Session.get();
    $('cartCard').classList.toggle('hidden', !session);
    $('cartCount').textContent = cart.length + (cart.length === 1 ? ' item' : ' items');
    const total = cart.reduce((s, e) => s + (Number(e.estimatedCost) || 0), 0);
    $('cartTotal').textContent = fmtMoney(total);
    $('submitAllBtn').disabled = cart.length === 0;

    $('cartList').innerHTML = cart.length === 0
      ? '<div class="text-soft" style="font-size:13px; padding:6px 0;">No items added yet.</div>'
      : cart.map((e, i) => `
        <div class="cart-row">
          <span class="name">${escapeHtml(e.itemName)}</span>
          <span class="meta">${e.quantity} ${escapeHtml(e.unit)}</span>
          <span class="cost">${fmtMoney(e.estimatedCost)}</span>
          <button type="button" class="rm" data-rm="${i}" aria-label="Remove">✕</button>
        </div>`).join('');

    $('cartList').querySelectorAll('[data-rm]').forEach(btn => btn.addEventListener('click', () => {
      cart.splice(Number(btn.dataset.rm), 1);
      renderCart();
    }));

    $('submitBtn').textContent = session ? 'Add to list' : 'Submit';
  }

  /** Clears only the item-specific fields, keeping date/outlet/department/staff name
   *  as-is so the salesman can quickly add their next item without re-typing context. */
  function resetItemFields() {
    clearItemSelection();
    activeCategory = 'All';
    $('itemSearch').value = '';
    costTouchedByUser = false;
    photoBase64 = null; photoMime = null; photoName = null;
    $('photoPreview').style.display = 'none'; $('photoPreview').src = '';
    $('photoLabel').textContent = 'Tap to take or upload a photo';
    $('fQuantity').value = 1;
    $('fReason').value = '';
    $('fRemarks').value = '';
    document.querySelectorAll('.field.invalid').forEach(f => f.classList.remove('invalid'));
    renderCategoryChips(); renderItemList();
  }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function setFieldError(fieldEl, hasError) {
    const wrap = fieldEl.closest('.field');
    if (wrap) wrap.classList.toggle('invalid', hasError);
    fieldEl.classList.toggle('err', hasError);
  }

  /* ---------- Load lookups (with offline cache fallback) ---------- */
  async function loadLookups() {
    try {
      const res = await WasteFlowAPI.call('lookups', {});
      if (res.ok) {
        lookups = res;
        localStorage.setItem(LOOKUPS_CACHE_KEY, JSON.stringify(res));
        return;
      }
    } catch (e) { /* fall through to cache */ }
    const cached = localStorage.getItem(LOOKUPS_CACHE_KEY);
    if (cached) {
      lookups = JSON.parse(cached);
      showToast('Offline — using last saved item list', 'error');
    } else {
      showToast('Could not load the item list. Check your connection.', 'error');
      lookups = { items: [], outlets: [], departments: [], categories: [], reasons: [] };
    }
  }

  function populateSelect(el, values, placeholder) {
    el.innerHTML = '';
    if (placeholder) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = placeholder; opt.disabled = true; opt.selected = true;
      el.appendChild(opt);
    }
    values.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      el.appendChild(opt);
    });
  }

  /* ---------- Item picker ---------- */
  let activeCategory = 'All';

  function renderCategoryChips() {
    const wrap = $('categoryChips');
    const cats = ['All', ...lookups.categories];
    wrap.innerHTML = '';
    cats.forEach(c => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (c === activeCategory ? ' active' : '');
      chip.textContent = c;
      chip.addEventListener('click', () => { activeCategory = c; renderCategoryChips(); renderItemList(); });
      wrap.appendChild(chip);
    });
  }

  function renderItemList() {
    const q = $('itemSearch').value.trim().toLowerCase();
    const listEl = $('itemList');

    // Don't dump all 400 items on screen by default — wait for the salesman
    // to either type a search term or pick a specific category chip.
    if (!q && activeCategory === 'All') {
      listEl.innerHTML = '<div class="item-empty">Start typing an item name, or choose a category above.</div>';
      return;
    }

    let items = lookups.items;
    if (activeCategory !== 'All') items = items.filter(i => i.category === activeCategory);
    if (q) items = items.filter(i => i.name.toLowerCase().includes(q));
    items = items.slice(0, 150); // keep the DOM light; search narrows it down fast

    listEl.innerHTML = '';
    if (items.length === 0) {
      listEl.innerHTML = '<div class="item-empty">No items match. Try a different search or category.</div>';
      return;
    }
    items.forEach(it => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'item-row';
      row.innerHTML = `<span>${escapeHtml(it.name)}</span><span class="cat">${escapeHtml(it.category)}</span>`;
      row.addEventListener('click', () => selectItem(it));
      listEl.appendChild(row);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function selectItem(it) {
    selectedItem = it;
    $('itemPickerBlock').classList.add('hidden');
    $('selectedItemBlock').classList.remove('hidden');
    $('itemErr').style.display = 'none';
    $('selectedItemName').textContent = it.name;
    $('selectedItemCat').textContent = it.category;
    if (it.unit) $('fUnit').value = it.unit;
    if (it.cost && !costTouchedByUser) {
      $('fCost').value = (Number(it.cost) * Number($('fQuantity').value || 1)).toFixed(2);
    }
  }

  function clearItemSelection() {
    selectedItem = null;
    $('itemPickerBlock').classList.remove('hidden');
    $('selectedItemBlock').classList.add('hidden');
  }

  /* ---------- Quantity stepper + auto cost ---------- */
  function recalcCost() {
    if (selectedItem && selectedItem.cost && !costTouchedByUser) {
      $('fCost').value = (Number(selectedItem.cost) * Number($('fQuantity').value || 0)).toFixed(2);
    }
  }

  /* ---------- Who bar (session-aware) ---------- */
  function renderWhoBar() {
    const session = Session.get();
    const outletSelect = $('fOutlet');
    const lockHint = $('outletLockHint');

    if (session) {
      $('whoAvatar').textContent = (session.fullName || session.username || '?').charAt(0).toUpperCase();
      $('whoLabel').textContent = `${session.fullName || session.username} · ${session.role}`;
      $('whoSub').textContent = session.outlet && session.outlet !== 'All' ? `Outlet: ${session.outlet}` : 'All outlets';
      $('whoActionBtn').textContent = 'Sign out';
      $('fStaffName').value = session.fullName || session.username;

      if (session.outlet && session.outlet !== 'All' && session.role !== 'Admin') {
        const trySet = () => {
          if (outletSelect.querySelector(`option[value="${CSS.escape(session.outlet)}"]`)) {
            outletSelect.value = session.outlet;
            outletSelect.disabled = true;
            lockHint.classList.remove('hidden');
          }
        };
        trySet(); setTimeout(trySet, 300);
      } else {
        outletSelect.disabled = false;
        lockHint.classList.add('hidden');
      }
    } else {
      $('whoAvatar').textContent = '?';
      $('whoLabel').textContent = 'Not signed in — enter your name below';
      $('whoSub').textContent = 'Anyone at your outlet can submit without an account.';
      $('whoActionBtn').textContent = 'Sign in';
      outletSelect.disabled = false;
      lockHint.classList.add('hidden');
    }
    renderCart();
  }

  function openLoginModal() {
    $('loginModalErr').style.display = 'none';
    $('lmUsername').value = '';
    $('lmPassword').value = '';
    $('loginModal').classList.add('show');
  }

  async function handleWhoAction() {
    const session = Session.get();
    if (session) {
      // Signed in -> this click means "sign out"
      if (cart.length > 0 && !confirm(`You have ${cart.length} unsubmitted item(s) in today's list. Sign out anyway and lose them?`)) return;
      WasteFlowAPI.call('logout', { token: session.token }).catch(() => {});
      Session.clear();
      cart = [];
      renderWhoBar();
      showToast('Signed out', 'success');
    } else {
      openLoginModal();
    }
  }

  async function handleLoginModalSubmit(e) {
    e.preventDefault();
    const btn = $('loginModalSubmit');
    btn.disabled = true; btn.textContent = 'Signing in…';
    $('loginModalErr').style.display = 'none';
    try {
      const res = await WasteFlowAPI.call('login', { username: $('lmUsername').value.trim(), password: $('lmPassword').value });
      if (!res.ok) throw new Error(res.error || 'Invalid login');
      Session.set(res);
      $('loginModal').classList.remove('show');
      renderWhoBar();
      showToast('Signed in', 'success');
    } catch (err) {
      $('loginModalErr').textContent = err.message || 'Something went wrong.';
      $('loginModalErr').style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  }

  /* ---------- Photo ---------- */
  function handlePhoto(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result; // data:<mime>;base64,<data>
      const [meta, b64] = result.split(',');
      photoMime = meta.match(/data:(.*);base64/)[1];
      photoBase64 = b64;
      photoName = file.name || 'waste-photo.jpg';
      $('photoPreview').src = result;
      $('photoPreview').style.display = 'block';
      $('photoLabel').textContent = 'Photo attached — tap to change';
    };
    reader.readAsDataURL(file);
  }

  /* ---------- Validation ---------- */
  function validate() {
    let ok = true;
    const required = [
      ['fDate', $('fDate').value],
      ['fOutlet', $('fOutlet').value],
      ['fDepartment', $('fDepartment').value],
      ['fUnit', $('fUnit').value],
      ['fReason', $('fReason').value],
      ['fStaffName', $('fStaffName').value.trim()]
    ];
    required.forEach(([id, val]) => { const has = !val; setFieldError($(id), has); if (has) ok = false; });

    const qty = Number($('fQuantity').value);
    setFieldError($('fQuantity'), !(qty > 0));
    if (!(qty > 0)) ok = false;

    if (!selectedItem) { $('itemErr').style.display = 'block'; ok = false; } else { $('itemErr').style.display = 'none'; }

    return ok;
  }

  /* ---------- Submit ---------- */
  function buildPayload() {
    const session = Session.get();
    return {
      token: session ? session.token : undefined,
      date: $('fDate').value,
      outlet: $('fOutlet').value,
      department: $('fDepartment').value,
      category: selectedItem ? selectedItem.category : '',
      itemName: selectedItem ? selectedItem.name : '',
      quantity: Number($('fQuantity').value),
      unit: $('fUnit').value,
      estimatedCost: $('fCost').value ? Number($('fCost').value) : 0,
      reason: $('fReason').value,
      staffName: $('fStaffName').value.trim(),
      remarks: $('fRemarks').value.trim(),
      photoBase64: photoBase64 || undefined,
      photoMime: photoMime || undefined,
      photoName: photoName || undefined
    };
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validate()) { showToast('Please fill in all required fields', 'error'); return; }

    const payload = buildPayload();
    const session = Session.get();

    // Logged-in flow: build up a list, submit everything at once at the end.
    if (session) {
      cart.push(payload);
      resetItemFields();
      renderCart();
      showToast(`Added — ${cart.length} item${cart.length === 1 ? '' : 's'} in today's list`, 'success');
      return;
    }

    // Anonymous / kiosk flow: submit this single entry immediately, as before.
    const btn = $('submitBtn');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      if (!navigator.onLine) throw new Error('offline');
      const res = await WasteFlowAPI.call('submitEntry', payload);
      if (!res.ok) throw new Error(res.error || 'Submission failed');
      showSuccess(false, 1);
    } catch (err) {
      OfflineQueue.push(payload);
      showSuccess(true, 1);
    } finally {
      btn.disabled = false; btn.textContent = 'Submit';
    }
  }

  async function submitAllAndLogout() {
    const session = Session.get();
    if (!session || cart.length === 0) return;

    const btn = $('submitAllBtn');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      if (!navigator.onLine) throw new Error('offline');
      const res = await WasteFlowAPI.call('submitEntriesBatch', { token: session.token, entries: cart });
      if (!res.ok) throw new Error(res.error || 'Submission failed');
      const count = res.count;
      cart = [];
      WasteFlowAPI.call('logout', { token: session.token }).catch(() => {});
      Session.clear();
      resetForm();
      showSuccess(false, count);
    } catch (err) {
      // Offline or backend unreachable — queue every cart item individually so
      // nothing is lost, then still sign the person out since their shift is done.
      cart.forEach(entry => OfflineQueue.push(entry));
      const count = cart.length;
      cart = [];
      WasteFlowAPI.call('logout', { token: session.token }).catch(() => {});
      Session.clear();
      resetForm();
      showSuccess(true, count);
    } finally {
      btn.disabled = false; btn.textContent = "Submit all & sign out";
    }
  }

  function showSuccess(offline, count) {
    const n = count || 1;
    document.querySelector('#successScreen h2').textContent = offline ? 'Saved locally' : (n > 1 ? `${n} entries logged` : 'Entry logged');
    document.querySelector('#successScreen p').textContent = offline
      ? "You're offline — this will sync automatically once you're back online."
      : (n > 1 ? `Thanks — all ${n} items have been saved to the waste log.` : 'Thanks — this has been saved to the waste log.');
    $('successScreen').classList.add('show');
  }

  function resetForm() {
    document.getElementById('wasteForm').reset();
    $('fDate').value = todayStr();
    resetItemFields();
    renderWhoBar();
  }

  /* ---------- Offline banner + auto-sync ---------- */
  function updateOfflineBanner() {
    $('offlineBanner').classList.toggle('show', !navigator.onLine);
  }

  async function trySyncQueue() {
    if (!navigator.onLine) return;
    const q = OfflineQueue.all();
    if (q.length === 0) return;
    const { flushed } = await flushOfflineQueue();
    if (flushed > 0) showToast(`Synced ${flushed} offline ${flushed === 1 ? 'entry' : 'entries'}`, 'success');
  }

  /* ---------- Init ---------- */
  async function init() {
    $('fDate').value = todayStr();
    await loadLookups();
    populateSelect($('fOutlet'), lookups.outlets, 'Select outlet');
    populateSelect($('fDepartment'), lookups.departments, 'Select department');
    populateSelect($('fReason'), lookups.reasons, 'Select reason');
    renderCategoryChips();
    renderItemList();
    renderWhoBar();

    $('itemSearch').addEventListener('input', renderItemList);
    $('changeItemBtn').addEventListener('click', clearItemSelection);
    $('qtyMinus').addEventListener('click', () => { $('fQuantity').value = Math.max(0, (Number($('fQuantity').value) || 0) - 1); recalcCost(); });
    $('qtyPlus').addEventListener('click', () => { $('fQuantity').value = (Number($('fQuantity').value) || 0) + 1; recalcCost(); });
    $('fQuantity').addEventListener('input', recalcCost);
    $('fCost').addEventListener('input', () => costTouchedByUser = true);
    $('fPhoto').addEventListener('change', e => handlePhoto(e.target.files[0]));
    $('wasteForm').addEventListener('submit', handleSubmit);
    $('clearBtn').addEventListener('click', resetForm);
    $('logAnotherBtn').addEventListener('click', () => { $('successScreen').classList.remove('show'); resetForm(); });
    $('viewAdminBtn').addEventListener('click', () => window.location.href = 'admin.html');
    $('whoActionBtn').addEventListener('click', handleWhoAction);
    $('submitAllBtn').addEventListener('click', submitAllAndLogout);
    $('loginModalForm').addEventListener('submit', handleLoginModalSubmit);
    $('loginModalCancel').addEventListener('click', () => $('loginModal').classList.remove('show'));

    window.addEventListener('online', () => { updateOfflineBanner(); trySyncQueue(); });
    window.addEventListener('offline', updateOfflineBanner);
    updateOfflineBanner();
    trySyncQueue();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
