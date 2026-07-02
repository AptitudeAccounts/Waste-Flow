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

  const $ = id => document.getElementById(id);

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
    if (session) {
      $('whoAvatar').textContent = (session.fullName || session.username || '?').charAt(0).toUpperCase();
      $('whoLabel').textContent = `${session.fullName || session.username} · ${session.role}`;
      $('whoSub').textContent = session.outlet && session.outlet !== 'All' ? `Outlet: ${session.outlet}` : 'All outlets';
      $('signInLink').textContent = 'Dashboard →';
      $('fStaffName').value = session.fullName || session.username;
      if (session.outlet && session.outlet !== 'All') {
        // pre-set once outlets are loaded
        const trySet = () => { if ($('fOutlet').querySelector(`option[value="${CSS.escape(session.outlet)}"]`)) $('fOutlet').value = session.outlet; };
        trySet(); setTimeout(trySet, 300);
      }
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
    const btn = $('submitBtn');
    btn.disabled = true; btn.textContent = 'Submitting…';

    try {
      if (!navigator.onLine) throw new Error('offline');
      const res = await WasteFlowAPI.call('submitEntry', payload);
      if (!res.ok) throw new Error(res.error || 'Submission failed');
      showSuccess(false);
    } catch (err) {
      OfflineQueue.push(payload);
      showSuccess(true);
    } finally {
      btn.disabled = false; btn.textContent = 'Submit';
    }
  }

  function showSuccess(offline) {
    document.querySelector('#successScreen h2').textContent = offline ? 'Saved locally' : 'Entry logged';
    document.querySelector('#successScreen p').textContent = offline
      ? "You're offline — this will sync automatically once you're back online."
      : 'Thanks — this has been saved to the waste log.';
    $('successScreen').classList.add('show');
  }

  function resetForm() {
    document.getElementById('wasteForm').reset();
    $('fDate').value = todayStr();
    clearItemSelection();
    activeCategory = 'All';
    $('itemSearch').value = '';
    costTouchedByUser = false;
    photoBase64 = null; photoMime = null; photoName = null;
    $('photoPreview').style.display = 'none'; $('photoPreview').src = '';
    $('photoLabel').textContent = 'Tap to take or upload a photo';
    $('fQuantity').value = 1;
    document.querySelectorAll('.field.invalid').forEach(f => f.classList.remove('invalid'));
    renderCategoryChips(); renderItemList();
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

    window.addEventListener('online', () => { updateOfflineBanner(); trySyncQueue(); });
    window.addEventListener('offline', updateOfflineBanner);
    updateOfflineBanner();
    trySyncQueue();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
