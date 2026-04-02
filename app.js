(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // IndexedDB helper
  // ---------------------------------------------------------------------------
  const DB_NAME = 'filmtrack';
  const DB_VERSION = 1;
  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('rolls')) {
          const rolls = db.createObjectStore('rolls', { keyPath: 'id', autoIncrement: true });
          rolls.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('frames')) {
          const frames = db.createObjectStore('frames', { keyPath: 'id', autoIncrement: true });
          frames.createIndex('rollId', 'rollId');
          frames.createIndex('rollId_frame', ['rollId', 'frameNumber']);
        }
      };
      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function tx(storeName, mode) {
    return _db.transaction(storeName, mode).objectStore(storeName);
  }

  function idbReq(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGetAll(storeName) {
    return idbReq(tx(storeName, 'readonly').getAll());
  }

  function idbGet(storeName, key) {
    return idbReq(tx(storeName, 'readonly').get(key));
  }

  function idbPut(storeName, obj) {
    return idbReq(tx(storeName, 'readwrite').put(obj));
  }

  function idbAdd(storeName, obj) {
    return idbReq(tx(storeName, 'readwrite').add(obj));
  }

  function idbDelete(storeName, key) {
    return idbReq(tx(storeName, 'readwrite').delete(key));
  }

  function idbIndex(storeName, indexName, query) {
    return idbReq(tx(storeName, 'readonly').index(indexName).getAll(query));
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const $content = () => $('#app-content');
  const $title = () => $('#app-title');
  const $backBtn = () => $('#back-btn');
  const $barActions = () => $('#app-bar-actions');
  const $nav = () => $('#bottom-nav');

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'className') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
        else e.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else if (c) e.appendChild(c);
    }
    return e;
  }

  function setContent(node) {
    const c = $content();
    c.innerHTML = '';
    if (typeof node === 'string') c.innerHTML = node;
    else c.appendChild(node);
  }

  function showBack(show) {
    $backBtn().classList.toggle('hidden', !show);
  }

  function setBarActions(html) {
    $barActions().innerHTML = '';
    if (html instanceof HTMLElement) $barActions().appendChild(html);
    else $barActions().innerHTML = html || '';
  }

  function showNav(show) {
    $nav().classList.toggle('hidden', !show);
  }

  function setActiveTab(name) {
    document.querySelectorAll('.nav-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === name);
    });
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------
  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function formatCoord(lat, lon) {
    if (lat == null || lon == null) return null;
    return lat.toFixed(6) + ', ' + lon.toFixed(6);
  }

  // ---------------------------------------------------------------------------
  // Thumbnail generation
  // ---------------------------------------------------------------------------
  function generateThumbnail(blob) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        const MAX = 300;
        let w = img.width, h = img.height;
        if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob((tb) => {
          URL.revokeObjectURL(url);
          resolve(tb);
        }, 'image/jpeg', 0.7);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  // ---------------------------------------------------------------------------
  // EXIF metadata extraction
  // ---------------------------------------------------------------------------
  function extractExifData(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = function () {
        try {
          const view = new DataView(reader.result);
          // Check JPEG SOI marker
          if (view.getUint16(0) !== 0xFFD8) { resolve(null); return; }
          let offset = 2;
          while (offset < view.byteLength - 1) {
            const marker = view.getUint16(offset);
            if (marker === 0xFFE1) { // APP1 (EXIF)
              const length = view.getUint16(offset + 2);
              const exifBlock = offset + 4;
              // Check "Exif\0\0"
              if (view.getUint32(exifBlock) === 0x45786966 && view.getUint16(exifBlock + 4) === 0x0000) {
                const tiffStart = exifBlock + 6;
                const result = parseExifTiff(view, tiffStart);
                resolve(result);
                return;
              }
              offset += 2 + length;
            } else if ((marker & 0xFF00) === 0xFF00) {
              if (marker === 0xFFDA) break; // Start of scan, stop
              offset += 2 + view.getUint16(offset + 2);
            } else {
              break;
            }
          }
          resolve(null);
        } catch (e) {
          resolve(null);
        }
      };
      reader.onerror = () => resolve(null);
      reader.readAsArrayBuffer(blob);
    });
  }

  function parseExifTiff(view, tiffStart) {
    const bigEndian = view.getUint16(tiffStart) === 0x4D4D;
    const g16 = (o) => view.getUint16(o, !bigEndian);
    const g32 = (o) => view.getUint32(o, !bigEndian);

    function getRational(offset) {
      const num = g32(offset);
      const den = g32(offset + 4);
      return den ? num / den : 0;
    }

    function readString(offset, count) {
      let s = '';
      for (let i = 0; i < count - 1; i++) {
        const c = view.getUint8(offset + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    }

    function readIFDEntries(ifdOffset) {
      const entries = {};
      const count = g16(ifdOffset);
      for (let i = 0; i < count; i++) {
        const entryOffset = ifdOffset + 2 + i * 12;
        const tag = g16(entryOffset);
        const type = g16(entryOffset + 2);
        const numValues = g32(entryOffset + 4);
        const valueOffset = entryOffset + 8;
        entries[tag] = { type, numValues, valueOffset };
      }
      return entries;
    }

    function getEntryValue(entry) {
      const dataSize = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][entry.type] || 0;
      const totalSize = dataSize * entry.numValues;
      const offset = totalSize > 4 ? tiffStart + g32(entry.valueOffset) : entry.valueOffset;
      if (entry.type === 2) return readString(offset, entry.numValues); // ASCII
      if (entry.type === 5 || entry.type === 10) return offset; // Rational offset
      if (entry.type === 3) return g16(offset); // SHORT
      if (entry.type === 4) return g32(offset); // LONG
      if (entry.type === 1) return view.getUint8(offset); // BYTE
      return null;
    }

    function dmsToDecimal(rationalOffset, count) {
      if (count < 3) return null;
      const deg = getRational(rationalOffset);
      const min = getRational(rationalOffset + 8);
      const sec = getRational(rationalOffset + 16);
      return deg + min / 60 + sec / 3600;
    }

    const result = { latitude: null, longitude: null, altitude: null, dateTime: null, cameraMake: null, cameraModel: null };

    try {
      const ifd0Offset = tiffStart + g32(tiffStart + 4);
      const ifd0 = readIFDEntries(ifd0Offset);

      // Camera Make (tag 0x010F) and Model (tag 0x0110)
      if (ifd0[0x010F]) result.cameraMake = getEntryValue(ifd0[0x010F]);
      if (ifd0[0x0110]) result.cameraModel = getEntryValue(ifd0[0x0110]);

      // Find EXIF sub-IFD for DateTimeOriginal
      if (ifd0[0x8769]) {
        const exifIFDOffset = tiffStart + g32(ifd0[0x8769].valueOffset);
        const exifIFD = readIFDEntries(exifIFDOffset);
        // DateTimeOriginal (0x9003) or DateTimeDigitized (0x9004) or DateTime (0x0132)
        const dtTag = exifIFD[0x9003] || exifIFD[0x9004];
        if (dtTag) {
          const dtStr = getEntryValue(dtTag);
          if (dtStr) {
            // Format: "YYYY:MM:DD HH:MM:SS" -> ISO
            const iso = dtStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
            result.dateTime = iso;
          }
        }
      }
      if (!result.dateTime && ifd0[0x0132]) {
        const dtStr = getEntryValue(ifd0[0x0132]);
        if (dtStr) {
          const iso = dtStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
          result.dateTime = iso;
        }
      }

      // Find GPS IFD
      if (ifd0[0x8825]) {
        const gpsIFDOffset = tiffStart + g32(ifd0[0x8825].valueOffset);
        const gpsIFD = readIFDEntries(gpsIFDOffset);

        // Latitude: tag 0x0002 (value), 0x0001 (ref N/S)
        if (gpsIFD[0x0002] && gpsIFD[0x0001]) {
          const latRef = getEntryValue(gpsIFD[0x0001]);
          const latOffset = getEntryValue(gpsIFD[0x0002]);
          let lat = dmsToDecimal(latOffset, gpsIFD[0x0002].numValues);
          if (lat != null && (latRef === 'S' || latRef === 83)) lat = -lat;
          result.latitude = lat;
        }

        // Longitude: tag 0x0004 (value), 0x0003 (ref E/W)
        if (gpsIFD[0x0004] && gpsIFD[0x0003]) {
          const lonRef = getEntryValue(gpsIFD[0x0003]);
          const lonOffset = getEntryValue(gpsIFD[0x0004]);
          let lon = dmsToDecimal(lonOffset, gpsIFD[0x0004].numValues);
          if (lon != null && (lonRef === 'W' || lonRef === 87)) lon = -lon;
          result.longitude = lon;
        }

        // Altitude: tag 0x0006 (value), 0x0005 (ref: 0=above sea, 1=below)
        if (gpsIFD[0x0006]) {
          const altOffset = getEntryValue(gpsIFD[0x0006]);
          let alt = getRational(altOffset);
          if (gpsIFD[0x0005]) {
            const altRef = getEntryValue(gpsIFD[0x0005]);
            if (altRef === 1) alt = -alt;
          }
          result.altitude = alt;
        }
      }
    } catch (e) {
      // Partial parse is fine, return what we have
    }

    // Return null if nothing useful was found
    if (result.latitude == null && result.dateTime == null && result.cameraMake == null) return null;
    return result;
  }

  // ---------------------------------------------------------------------------
  // GPS helper
  // ---------------------------------------------------------------------------
  function getGPS() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          altitude: pos.coords.altitude,
          locationAccuracy: pos.coords.accuracy
        }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Spinner
  // ---------------------------------------------------------------------------
  function showSpinner(msg) {
    const overlay = el('div', { className: 'spinner-overlay', id: 'spinner' },
      el('div', { className: 'spinner' }),
      el('span', null, msg || 'Loading...')
    );
    document.body.appendChild(overlay);
  }

  function hideSpinner() {
    const s = $('#spinner');
    if (s) s.remove();
  }

  // ---------------------------------------------------------------------------
  // Modal / Dialog
  // ---------------------------------------------------------------------------
  function showModal(titleText, buildContent) {
    return new Promise((resolve) => {
      const overlay = el('div', { className: 'modal-overlay', id: 'modal-overlay' });
      const modal = el('div', { className: 'modal' });
      const title = el('div', { className: 'modal-title' }, titleText);
      modal.appendChild(title);

      const close = (val) => {
        overlay.remove();
        resolve(val);
      };

      const content = buildContent(close);
      modal.appendChild(content);
      overlay.appendChild(modal);

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });

      document.body.appendChild(overlay);
    });
  }

  function confirmDialog(msg) {
    return showModal('Confirm', (close) => {
      const wrap = el('div', null,
        el('p', { className: 'confirm-text' }, msg),
        el('div', { className: 'confirm-actions' },
          el('button', { className: 'btn btn-secondary', onClick: () => close(false) }, 'Cancel'),
          el('button', { className: 'btn btn-danger', onClick: () => close(true) }, 'Delete')
        )
      );
      return wrap;
    });
  }

  // ---------------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------------
  function navigate(hash) {
    location.hash = hash;
  }

  function getRoute() {
    const h = location.hash.replace('#', '') || 'rolls';
    const parts = h.split('/');
    return { path: parts[0], id: parts[1] ? parseInt(parts[1], 10) : null };
  }

  async function route() {
    const r = getRoute();
    switch (r.path) {
      case 'rolls': await renderRolls(); break;
      case 'roll': await renderRoll(r.id); break;
      case 'frame': await renderFrame(r.id); break;
      case 'export': await renderExport(); break;
      default: await renderRolls();
    }
  }

  // ---------------------------------------------------------------------------
  // View: Rolls list
  // ---------------------------------------------------------------------------
  async function renderRolls() {
    showBack(false);
    setBarActions('');
    showNav(true);
    setActiveTab('rolls');
    $title().textContent = 'FilmTrack';

    const rolls = await idbGetAll('rolls');
    rolls.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const wrap = el('div');

    if (rolls.length === 0) {
      wrap.appendChild(el('div', { className: 'empty-state' },
        el('div', { className: 'empty-state-icon' }, '\u{1F4F7}'),
        el('div', { className: 'empty-state-text' }, 'No rolls yet. Tap + to start.')
      ));
    } else {
      for (const roll of rolls) {
        const frames = await idbIndex('frames', 'rollId', roll.id);
        const card = el('div', { className: 'roll-card', onClick: () => navigate('roll/' + roll.id) },
          el('div', { className: 'roll-card-header' },
            el('div', { className: 'roll-card-name' }, roll.name || 'Untitled Roll'),
            el('div', { className: 'roll-card-frames' }, frames.length + '/' + roll.frameCount)
          ),
          el('div', { className: 'roll-card-meta' },
            el('span', null, roll.filmStock || '—'),
            el('span', null, 'ISO ' + (roll.iso || '—')),
            el('span', null, formatDate(roll.createdAt))
          )
        );
        wrap.appendChild(card);
      }
    }

    // FAB (fixed position)
    const fabWrap = el('div', { className: 'fab-wrap' });
    const fab = el('button', { className: 'fab', onClick: openNewRollDialog, 'aria-label': 'New roll' }, '+');
    fabWrap.appendChild(fab);
    wrap.appendChild(fabWrap);

    setContent(wrap);
  }

  // ---------------------------------------------------------------------------
  // New Roll Dialog
  // ---------------------------------------------------------------------------
  async function openNewRollDialog() {
    const result = await showModal('New Roll', (close) => {
      const nameInput = el('input', { type: 'text', placeholder: 'e.g. Street Walk Downtown', id: 'nr-name' });
      const stockInput = el('input', { type: 'text', placeholder: 'e.g. Portra 400', id: 'nr-stock' });
      const isoInput = el('input', { type: 'number', value: '400', id: 'nr-iso' });
      const countInput = el('input', { type: 'number', value: '36', id: 'nr-count' });
      const notesInput = el('textarea', { placeholder: 'Optional notes...', id: 'nr-notes' });

      const form = el('div', null,
        el('div', { className: 'form-group' }, el('label', null, 'Roll Name'), nameInput),
        el('div', { className: 'form-group' }, el('label', null, 'Film Stock'), stockInput),
        el('div', { className: 'form-group' }, el('label', null, 'ISO'), isoInput),
        el('div', { className: 'form-group' }, el('label', null, 'Frame Count'), countInput),
        el('div', { className: 'form-group' }, el('label', null, 'Notes'), notesInput),
        el('div', { className: 'form-actions' },
          el('button', { className: 'btn btn-secondary', onClick: () => close(null) }, 'Cancel'),
          el('button', {
            className: 'btn btn-primary',
            onClick: () => close({
              name: nameInput.value.trim(),
              filmStock: stockInput.value.trim(),
              iso: parseInt(isoInput.value, 10) || 400,
              frameCount: parseInt(countInput.value, 10) || 36,
              notes: notesInput.value.trim(),
              createdAt: new Date().toISOString()
            })
          }, 'Create')
        )
      );
      return form;
    });

    if (result) {
      await idbAdd('rolls', result);
      await renderRolls();
    }
  }

  // ---------------------------------------------------------------------------
  // View: Single Roll (frame grid)
  // ---------------------------------------------------------------------------
  async function renderRoll(rollId) {
    const roll = await idbGet('rolls', rollId);
    if (!roll) { navigate('rolls'); return; }

    showBack(true);
    showNav(false);
    $title().textContent = roll.name || 'Untitled Roll';

    // Delete button in header
    const deleteBtn = el('button', {
      className: 'delete-roll-btn',
      'aria-label': 'Delete roll',
      onClick: async () => {
        const yes = await confirmDialog('Delete "' + (roll.name || 'this roll') + '" and all its frames?');
        if (yes) {
          const frames = await idbIndex('frames', 'rollId', rollId);
          for (const f of frames) await idbDelete('frames', f.id);
          await idbDelete('rolls', rollId);
          navigate('rolls');
        }
      }
    }, '\u{1F5D1}');
    setBarActions(deleteBtn);

    const frames = await idbIndex('frames', 'rollId', rollId);
    frames.sort((a, b) => a.frameNumber - b.frameNumber);

    const wrap = el('div');

    // Roll info bar
    const meta = el('div', { className: 'roll-card-meta', style: 'margin-bottom:16px' },
      el('span', null, roll.filmStock || '—'),
      el('span', null, 'ISO ' + (roll.iso || '—')),
      el('span', null, frames.length + '/' + roll.frameCount + ' frames')
    );
    wrap.appendChild(meta);

    // Warning if over frame count
    if (frames.length >= roll.frameCount) {
      wrap.appendChild(el('div', { className: 'warning-banner' },
        'Frame count reached (' + roll.frameCount + '). You can still capture more.'
      ));
    }

    if (frames.length === 0) {
      wrap.appendChild(el('div', { className: 'empty-state' },
        el('div', { className: 'empty-state-icon' }, '\u{1F3DE}'),
        el('div', { className: 'empty-state-text' }, 'No frames yet. Tap the capture button.')
      ));
    } else {
      const grid = el('div', { className: 'frame-grid' });
      for (const frame of frames) {
        const hasGPS = frame.latitude != null && frame.longitude != null;
        const thumb = frame.thumbnailBlob
          ? el('img', { className: 'frame-thumb', src: URL.createObjectURL(frame.thumbnailBlob) })
          : el('div', { className: 'frame-thumb' });

        const card = el('div', {
          className: 'frame-card',
          onClick: () => navigate('frame/' + frame.id)
        },
          thumb,
          el('div', { className: 'frame-info' },
            el('div', { className: 'frame-number' },
              '#' + frame.frameNumber,
              el('span', { className: 'gps-dot ' + (hasGPS ? 'ok' : 'warn') })
            ),
            el('div', { className: 'frame-date' }, formatDate(frame.capturedAt))
          )
        );
        grid.appendChild(card);
      }
      wrap.appendChild(grid);
    }

    // FAB menu for capture/upload
    const fabWrap = el('div', { className: 'fab-wrap' });

    const fabMenu = el('div', { className: 'fab-menu hidden' },
      el('button', {
        className: 'fab-menu-item',
        onClick: () => { fabMenu.classList.add('hidden'); startCapture(rollId, frames.length + 1, roll.frameCount, 'camera'); },
        'aria-label': 'Take photo'
      }, '\u{1F4F7}', el('span', { className: 'fab-menu-label' }, 'Take Photo')),
      el('button', {
        className: 'fab-menu-item',
        onClick: () => { fabMenu.classList.add('hidden'); startCapture(rollId, frames.length + 1, roll.frameCount, 'file'); },
        'aria-label': 'Upload file'
      }, '\u{1F4C1}', el('span', { className: 'fab-menu-label' }, 'Upload File'))
    );

    const closeFabMenu = (e) => {
      if (!fabWrap.contains(e.target)) {
        fabMenu.classList.add('hidden');
        document.removeEventListener('click', closeFabMenu);
      }
    };

    const fab = el('button', {
      className: 'fab',
      onClick: () => {
        const isNowHidden = fabMenu.classList.toggle('hidden');
        if (!isNowHidden) {
          setTimeout(() => document.addEventListener('click', closeFabMenu), 0);
        } else {
          document.removeEventListener('click', closeFabMenu);
        }
      },
      'aria-label': 'Add frame'
    }, '\u{1F4F7}');

    fabWrap.appendChild(fabMenu);
    fabWrap.appendChild(fab);
    wrap.appendChild(fabWrap);

    setContent(wrap);
  }

  // ---------------------------------------------------------------------------
  // Frame Capture
  // ---------------------------------------------------------------------------
  function startCapture(rollId, nextFrame, maxFrames, mode) {
    const input = mode === 'file' ? $('#file-input') : $('#camera-input');
    input.value = '';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;

      const isUpload = mode === 'file';

      showSpinner(isUpload ? 'Reading file metadata...' : 'Acquiring GPS...');

      const tasks = [generateThumbnail(file)];
      if (isUpload) {
        tasks.push(extractExifData(file));
      } else {
        tasks.push(getGPS());
      }

      const [thumbnail, metaOrGps] = await Promise.all(tasks);

      hideSpinner();

      let latitude = null, longitude = null, altitude = null, locationAccuracy = null;
      let capturedAt = new Date().toISOString();
      let cameraMake = null, cameraModel = null;
      let hasLocation = false;

      if (isUpload && metaOrGps) {
        // Use EXIF metadata from the file
        const exif = metaOrGps;
        latitude = exif.latitude;
        longitude = exif.longitude;
        altitude = exif.altitude;
        locationAccuracy = null; // EXIF doesn't provide accuracy
        if (exif.dateTime) capturedAt = exif.dateTime;
        cameraMake = exif.cameraMake || null;
        cameraModel = exif.cameraModel || null;
        hasLocation = latitude != null;
      } else if (!isUpload && metaOrGps) {
        // Use device GPS for camera captures
        const gps = metaOrGps;
        latitude = gps.latitude;
        longitude = gps.longitude;
        altitude = gps.altitude;
        locationAccuracy = gps.locationAccuracy;
        hasLocation = true;
      }

      const frame = {
        rollId: rollId,
        frameNumber: nextFrame,
        photoBlob: file,
        thumbnailBlob: thumbnail,
        latitude: latitude,
        longitude: longitude,
        altitude: altitude,
        locationAccuracy: locationAccuracy,
        capturedAt: capturedAt,
        cameraMake: cameraMake,
        cameraModel: cameraModel,
        notes: ''
      };

      await idbAdd('frames', frame);

      if (!hasLocation) {
        const msg = isUpload ? 'Saved (no location in file)' : 'Saved (no GPS)';
        showSpinner(msg);
        setTimeout(() => { hideSpinner(); renderRoll(rollId); }, 800);
      } else {
        await renderRoll(rollId);
      }
    };
    input.click();
  }

  // ---------------------------------------------------------------------------
  // View: Frame Detail
  // ---------------------------------------------------------------------------
  async function renderFrame(frameId) {
    const frame = await idbGet('frames', frameId);
    if (!frame) { navigate('rolls'); return; }

    const roll = await idbGet('rolls', frame.rollId);

    showBack(true);
    showNav(false);
    $title().textContent = 'Frame #' + frame.frameNumber;
    setBarActions('');

    const wrap = el('div');

    // Full image
    if (frame.photoBlob) {
      const img = el('img', { className: 'frame-detail-img', src: URL.createObjectURL(frame.photoBlob) });
      wrap.appendChild(img);
    }

    // Metadata section
    const hasGPS = frame.latitude != null;
    const section = el('div', { className: 'detail-section' },
      detailRow('Roll', roll ? roll.name : '—'),
      detailRow('Film Stock', roll ? (roll.filmStock || '—') : '—'),
      detailRow('ISO', roll ? (roll.iso || '—') : '—'),
      detailRow('Frame', '#' + frame.frameNumber),
      detailRow('Captured', formatDate(frame.capturedAt)),
      detailRow('Location', hasGPS ? formatCoord(frame.latitude, frame.longitude) : 'Not available'),
      detailRow('Altitude', frame.altitude != null ? frame.altitude.toFixed(1) + ' m' : '—'),
      detailRow('GPS Accuracy', frame.locationAccuracy != null ? frame.locationAccuracy.toFixed(1) + ' m' : '—'),
      detailRow('Camera', frame.cameraMake || frame.cameraModel
        ? [frame.cameraMake, frame.cameraModel].filter(Boolean).join(' ')
        : '—')
    );
    wrap.appendChild(section);

    // GPS status indicator
    if (!hasGPS) {
      wrap.appendChild(el('div', { className: 'warning-banner' }, 'GPS was not available for this frame.'));
    }

    // Notes
    const notesArea = el('textarea', {
      placeholder: 'Add notes...',
      style: 'width:100%;padding:12px;background:var(--bg-input);border:1px solid rgba(255,255,255,0.1);border-radius:var(--radius-sm);color:var(--text);font-size:15px;font-family:inherit;resize:vertical;min-height:80px;margin-bottom:12px;'
    });
    notesArea.value = frame.notes || '';

    let saveTimeout = null;
    notesArea.addEventListener('input', () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(async () => {
        frame.notes = notesArea.value;
        await idbPut('frames', frame);
      }, 500);
    });

    wrap.appendChild(el('div', { className: 'form-group' },
      el('label', null, 'Notes'),
      notesArea
    ));

    // Delete button
    wrap.appendChild(el('button', {
      className: 'btn btn-danger',
      style: 'width:100%;margin-top:8px',
      onClick: async () => {
        const yes = await confirmDialog('Delete frame #' + frame.frameNumber + '?');
        if (yes) {
          await idbDelete('frames', frame.id);
          navigate('roll/' + frame.rollId);
        }
      }
    }, 'Delete Frame'));

    setContent(wrap);
  }

  function detailRow(label, value) {
    return el('div', { className: 'detail-row' },
      el('span', { className: 'detail-label' }, label),
      el('span', { className: 'detail-value' }, String(value))
    );
  }

  // ---------------------------------------------------------------------------
  // View: Export
  // ---------------------------------------------------------------------------
  async function renderExport() {
    showBack(false);
    setBarActions('');
    showNav(true);
    setActiveTab('export');
    $title().textContent = 'Export';

    const rolls = await idbGetAll('rolls');
    const allFrames = await idbGetAll('frames');

    const wrap = el('div', { className: 'export-section' },
      el('p', null, rolls.length + ' roll(s), ' + allFrames.length + ' frame(s) total.'),
      el('div', { className: 'export-btns' },
        el('button', { className: 'btn btn-primary', onClick: () => exportJSON(rolls, allFrames) }, 'Export JSON'),
        el('button', { className: 'btn btn-secondary', onClick: () => exportCSV(rolls, allFrames) }, 'Export CSV')
      )
    );

    setContent(wrap);
  }

  function exportJSON(rolls, frames) {
    const data = rolls.map((r) => {
      const rollFrames = frames
        .filter((f) => f.rollId === r.id)
        .sort((a, b) => a.frameNumber - b.frameNumber)
        .map((f) => ({
          frameNumber: f.frameNumber,
          capturedAt: f.capturedAt,
          latitude: f.latitude,
          longitude: f.longitude,
          altitude: f.altitude,
          locationAccuracy: f.locationAccuracy,
          cameraMake: f.cameraMake || null,
          cameraModel: f.cameraModel || null,
          notes: f.notes || ''
        }));
      return {
        name: r.name,
        filmStock: r.filmStock,
        iso: r.iso,
        frameCount: r.frameCount,
        createdAt: r.createdAt,
        notes: r.notes || '',
        frames: rollFrames
      };
    });

    downloadFile('filmtrack-export.json', JSON.stringify(data, null, 2), 'application/json');
  }

  function exportCSV(rolls, frames) {
    const rollMap = {};
    for (const r of rolls) rollMap[r.id] = r;

    const header = 'roll_name,film_stock,iso,frame_number,captured_at,latitude,longitude,altitude,accuracy,camera,notes';
    const rows = frames
      .sort((a, b) => {
        if (a.rollId !== b.rollId) return a.rollId - b.rollId;
        return a.frameNumber - b.frameNumber;
      })
      .map((f) => {
        const r = rollMap[f.rollId] || {};
        const camera = [f.cameraMake, f.cameraModel].filter(Boolean).join(' ');
        return [
          csvEscape(r.name || ''),
          csvEscape(r.filmStock || ''),
          r.iso || '',
          f.frameNumber,
          f.capturedAt || '',
          f.latitude != null ? f.latitude.toFixed(6) : '',
          f.longitude != null ? f.longitude.toFixed(6) : '',
          f.altitude != null ? f.altitude.toFixed(1) : '',
          f.locationAccuracy != null ? f.locationAccuracy.toFixed(1) : '',
          csvEscape(camera),
          csvEscape(f.notes || '')
        ].join(',');
      });

    downloadFile('filmtrack-export.csv', header + '\n' + rows.join('\n'), 'text/csv');
  }

  function csvEscape(str) {
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------------------
  // Navigation and initialization
  // ---------------------------------------------------------------------------
  window.addEventListener('hashchange', route);

  // Bottom nav tab clicks
  document.querySelectorAll('.nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      navigate(tab.dataset.tab === 'export' ? 'export' : 'rolls');
    });
  });

  // Back button
  $backBtn().addEventListener('click', () => {
    // If on frame, go back to roll; if on roll, go back to rolls
    const r = getRoute();
    if (r.path === 'frame') {
      // Need to look up which roll this frame belongs to
      idbGet('frames', r.id).then((frame) => {
        if (frame) navigate('roll/' + frame.rollId);
        else navigate('rolls');
      });
    } else {
      navigate('rolls');
    }
  });

  // Service worker registration
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Boot
  openDB().then(() => route());

})();
