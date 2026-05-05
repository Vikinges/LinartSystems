(function () {

        const formEl = document.getElementById('pm-form');

        if (!formEl) return;



        const statusEl = document.getElementById('status');

        const submitButton = formEl.querySelector('button[type="submit"]');

        const uploadProgressEl = document.querySelector('[data-upload-progress]');

        const uploadProgressBarEl = document.querySelector('[data-upload-progress-bar]');

        const uploadProgressLabelEl = document.querySelector('[data-upload-progress-label]');

        const uploadFilesSummaryEl = document.querySelector('[data-upload-files]');

        let debugToggleEls = Array.from(document.querySelectorAll('[data-debug-toggle]'));

        const debugPanelEl = document.querySelector('[data-debug-panel]');

        const debugLogEl = document.querySelector('[data-debug-log]');

        const DEBUG_KEY = 'pm-form-debug-enabled';

        const MOBILE_MODE_KEY = 'pm-form-mobile-mode';

        const MOBILE_SCALE_KEY = 'pm-form-mobile-scale';

        let debugState = { enabled: false, timeline: [] };

        const templateSelectEl = document.querySelector('[data-template-select]');

        const templateSlugInput = document.querySelector('[data-template-slug]');

        const templateInfoEl = document.querySelector('[data-template-info]');

        const templateStatusEl = templateInfoEl ? templateInfoEl.querySelector('[data-template-status]') : null;

        const templateDescriptionEl = templateInfoEl

          ? templateInfoEl.querySelector('[data-template-description]')

          : null;

        const templatePreviewLink = templateInfoEl ? templateInfoEl.querySelector('[data-template-preview]') : null;

        const formTypeSelectEl = document.querySelector('[data-template-type]');

        const mobileModeToggle = document.querySelector('[data-mobile-mode]');

        const mobileScaleLabel = document.querySelector('[data-mobile-scale-label]');

        const mobileScaleDecBtn = document.querySelector('[data-mobile-scale-dec]');

        const mobileScaleIncBtn = document.querySelector('[data-mobile-scale-inc]');

        const mobileScaleDebug = document.querySelector('[data-mobile-scale-debug]');

        const partsOcrButton = document.querySelector('[data-parts-ocr]');

        const partsOcrInput = document.querySelector('[data-parts-ocr-input]');

        const partsOcrStatus = document.querySelector('[data-parts-ocr-status]');

        const adminModalEl = document.querySelector('[data-admin-modal]');

        const adminOpenBtn = document.querySelector('[data-admin-open]');

        const adminCloseButtons = adminModalEl

          ? adminModalEl.querySelectorAll('[data-admin-close]')

          : [];

        const adminDialogEl = adminModalEl ? adminModalEl.querySelector('[data-admin-content]') : null;

        const adminSectionEl = adminDialogEl ? adminDialogEl.querySelector('[data-admin-section]') : null;

        const adminUnauthEl = adminSectionEl ? adminSectionEl.querySelector('[data-admin-unauth]') : null;

        const adminAuthEl = adminSectionEl ? adminSectionEl.querySelector('[data-admin-auth]') : null;

        const adminLoginForm = adminSectionEl ? adminSectionEl.querySelector('[data-admin-login]') : null;

        const adminPasswordInput = adminSectionEl ? adminSectionEl.querySelector('[data-admin-password]') : null;

        const adminLoginErrorEl = adminSectionEl ? adminSectionEl.querySelector('[data-admin-login-error]') : null;

        const adminLogoutBtn = adminSectionEl ? adminSectionEl.querySelector('[data-admin-logout]') : null;

        const adminPasswordForm = adminSectionEl ? adminSectionEl.querySelector('[data-admin-password-change]') : null;

        const adminPasswordCurrentInput = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-password-current]')

          : null;

        const adminPasswordNewInput = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-password-new]')

          : null;

        const adminUploadForm = adminSectionEl ? adminSectionEl.querySelector('[data-admin-upload]') : null;

        const adminUploadInput = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-upload-input]')

          : null;

        const adminUploadLabelInput = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-upload-label]')

          : null;

        const adminUploadDescriptionInput = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-upload-description]')

          : null;

        const adminTemplateListEl = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-template-list]')

          : null;



        const isMobileMode = () => {

          return mobileModeToggle ? mobileModeToggle.checked : false;

        };



        const clampScale = (val) => {

          const num = Number(val);

          if (!Number.isFinite(num)) return 0.7;

          return Math.min(1.0, Math.max(0.4, num));

        };



        const updateMobileScaleLabel = (scale) => {

          if (mobileScaleLabel) {

            mobileScaleLabel.textContent = 'Scale: ' + Math.round(scale * 100) + '%';

          }

          if (mobileScaleDebug) {

            const container = document.querySelector('.container');

            const rect = container ? container.getBoundingClientRect() : null;

            const appliedScale = getComputedStyle(document.body).getPropertyValue('--mobile-scale').trim() || scale;

            mobileScaleDebug.textContent =

              'Applied: ' +

              appliedScale +

              ' | rect: ' +

              (rect ? Math.round(rect.width) + 'px' : 'n/a') +

              ' / viewport ' +

              Math.round(window.innerWidth) +

              'px';

          }

        };



        const getContainerRect = () => {

          const container = document.querySelector('.container');

          const rect = container ? container.getBoundingClientRect() : null;

          return rect

            ? { width: Math.round(rect.width), height: Math.round(rect.height) }

            : { width: null, height: null };

        };



        const applyMobileMode = (enabled, overrideScale) => {

          const scale = clampScale(overrideScale !== undefined ? overrideScale : window.localStorage.getItem(MOBILE_SCALE_KEY) || 0.7);

          document.body.style.setProperty('--mobile-scale', scale);

          updateMobileScaleLabel(scale);

          const rect = getContainerRect();

          const info = {

            enabled,

            scale,

            rect,

            viewport: { width: window.innerWidth, height: window.innerHeight },

          };

          console.log('[mobile-scale]', info);

          if (enabled) {

            document.body.classList.add('mobile-mode');

            window.localStorage.setItem(MOBILE_MODE_KEY, '1');

            window.localStorage.setItem(MOBILE_SCALE_KEY, String(scale));

          } else {

            document.body.classList.remove('mobile-mode');

            window.localStorage.removeItem(MOBILE_MODE_KEY);

          }

        };



        if (mobileModeToggle) {

          const storedMobile = window.localStorage.getItem(MOBILE_MODE_KEY);

          const storedScale = clampScale(window.localStorage.getItem(MOBILE_SCALE_KEY) || 0.7);

          mobileModeToggle.checked = storedMobile === '1';

          applyMobileMode(mobileModeToggle.checked, storedScale);

          mobileModeToggle.addEventListener('change', (event) => {

            applyMobileMode(event.target.checked);

          });

          const adjustScale = (delta) => {

            const current = clampScale(document.body.style.getPropertyValue('--mobile-scale') || storedScale);

            const next = clampScale(current + delta);

            if (mobileModeToggle && !mobileModeToggle.checked) {

              mobileModeToggle.checked = true;

            }

            applyMobileMode(mobileModeToggle ? mobileModeToggle.checked : true, next);

          };

          if (mobileScaleDecBtn) {

            mobileScaleDecBtn.addEventListener('click', (event) => {

              event.preventDefault();

              adjustScale(-0.05);

            });

          }

          if (mobileScaleIncBtn) {

            mobileScaleIncBtn.addEventListener('click', (event) => {

              event.preventDefault();

              adjustScale(0.05);

            });

          }

        } else {

          updateMobileScaleLabel(0.7);

        }



        window.pmTools = {

          setMobile: (enabled = true, scale = 0.7) => {

            if (mobileModeToggle) mobileModeToggle.checked = !!enabled;

            applyMobileMode(enabled, scale);

            console.log('[pmTools] setMobile', { enabled, scale });

          },

          logSizes: () => {

            const rect = getContainerRect();

            const scale =

              getComputedStyle(document.body).getPropertyValue('--mobile-scale').trim() || 'n/a';

            const mobile = isMobileMode();

            const viewport = { width: window.innerWidth, height: window.innerHeight };

            console.log('[pmTools] sizes', { mobile, scale, rect, viewport });

            return { mobile, scale, rect, viewport };

          },

        };





        const applyFormTypeVisibility = (formType) => {

          const type = formType || (formTypeSelectEl ? formTypeSelectEl.value : '');

          const targets = Array.from(document.querySelectorAll('[data-form-types]'));

          targets.forEach((el) => {

            const allowed = (el.getAttribute('data-form-types') || '')

              .split(',')

              .map((s) => s.trim())

              .filter(Boolean);

            const shouldShow = allowed.length === 0 || allowed.includes(type);

            el.hidden = !shouldShow;

            el.style.display = shouldShow ? '' : 'none';

            const inputs = el.querySelectorAll('input, select, textarea, button');

            inputs.forEach((node) => {

              if (node.hasAttribute('data-admin-open') || node.hasAttribute('data-admin-close')) return;

              node.disabled = !shouldShow;

            });

          });

        };

        if (formTypeSelectEl) {

          formTypeSelectEl.addEventListener('change', (event) => {

            applyFormTypeVisibility(event.target.value);

          });

          applyFormTypeVisibility(formTypeSelectEl.value);

        } else {

          applyFormTypeVisibility();

        }



        const warrantyYearsInput = formEl.querySelector('input[name="warranty_years"]');

        const warrantyBeginInput = formEl.querySelector('input[name="warranty_begin"]');

        const warrantyEndInput = formEl.querySelector('input[name="warranty_end"]');

        let warrantyEndTouched = false;



        const parseIsoDate = (value) => {

          if (!value || typeof value !== 'string') return null;

          const parts = value.split('-').map((p) => Number(p));

          if (parts.length !== 3) return null;

          const [year, month, day] = parts;

          if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;

          const date = new Date(Date.UTC(year, month - 1, day));

          if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {

            return null;

          }

          return date;

        };



        const formatIsoDate = (date) => {

          const y = date.getUTCFullYear();

          const m = String(date.getUTCMonth() + 1).padStart(2, '0');

          const d = String(date.getUTCDate()).padStart(2, '0');

          return [y, m, d].join('-');

        };



        const updateWarrantyEnd = () => {

          if (!warrantyYearsInput || !warrantyBeginInput || !warrantyEndInput) return;

          if (warrantyEndTouched && warrantyEndInput.value) return;

          const baseDate = parseIsoDate(warrantyBeginInput.value);

          const years = Number(warrantyYearsInput.value);

          if (!baseDate || !Number.isFinite(years)) return;

          const target = new Date(baseDate.getTime());

          target.setUTCFullYear(target.getUTCFullYear() + years);

          warrantyEndInput.value = formatIsoDate(target);

        };



        if (warrantyEndInput) {

          warrantyEndInput.addEventListener('input', () => {

            warrantyEndTouched = true;

          });

        }

        if (warrantyYearsInput) {

          warrantyYearsInput.addEventListener('input', () => {

            warrantyEndTouched = false;

            updateWarrantyEnd();

          });

        }

        if (warrantyBeginInput) {

          warrantyBeginInput.addEventListener('input', () => {

            warrantyEndTouched = false;

            updateWarrantyEnd();

          });

        }

        updateWarrantyEnd();



        const findActivePartsSection = () => {

          const sections = Array.from(document.querySelectorAll('[data-parts-section]'));

          return sections.find((section) => !section.hidden && section.style.display !== 'none') || null;

        };



        const findActivePartsTable = () => {

          const section = findActivePartsSection();

          if (!section) return null;

          return section.querySelector('[data-parts-table]');

        };



        const findFirstVisiblePartsRow = () => {

          const table = findActivePartsTable();

          if (!table) return null;

          const rows = Array.from(table.querySelectorAll('tbody tr')).filter((r) => !r.classList.contains('is-hidden-row'));

          // Ð—Ð°Ð¿Ð¾Ð»Ð½ÑÐµÐ¼ Ð¿Ð¾ÑÐ»ÐµÐ´Ð½ÑŽÑŽ Ð¾Ñ‚ÐºÑ€Ñ‹Ñ‚ÑƒÑŽ ÑÑ‚Ñ€Ð¾ÐºÑƒ (Ð¾Ð±Ñ‹Ñ‡Ð½Ð¾ Ñ‚Ð¾Ð»ÑŒÐºÐ¾ Ñ‡Ñ‚Ð¾ Ð´Ð¾Ð±Ð°Ð²Ð»ÐµÐ½Ð½Ð°Ñ)

          return rows.length ? rows[rows.length - 1] : null;

        };



        const loadTesseract = () =>

          new Promise((resolve, reject) => {

            if (window.Tesseract) return resolve(window.Tesseract);

            const script = document.createElement('script');

            script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/tesseract.min.js';

            script.onload = () => resolve(window.Tesseract);

            script.onerror = () => reject(new Error('Failed to load Tesseract.js'));

            document.head.appendChild(script);

          });

        const loadZxing = () =>

          new Promise((resolve, reject) => {

            if (window.ZXing) return resolve(window.ZXing);

            const script = document.createElement('script');

            script.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js';

            script.onload = () => resolve(window.ZXing);

            script.onerror = () => reject(new Error('Failed to load ZXing'));

            document.head.appendChild(script);

          });

        const readFileAsDataUrl = (file) =>

          new Promise((resolve, reject) => {

            const reader = new FileReader();

            reader.onload = () => resolve(reader.result);

            reader.onerror = () => reject(new Error('Failed to read file'));

            reader.readAsDataURL(file);

          });



        
        const callPaddleOcr = async (dataUrl) => {
          const base64 = (dataUrl || '').split(',').pop();
          if (!base64) throw new Error('Unable to read image.');
          const response = await fetch('/api/ocr/paddle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64 }),
          });
          let payload = {};
          try {
            payload = await response.json();
          } catch (err) {
            payload = {};
          }
          if (!response.ok) {
            const message = (payload && payload.error) || response.statusText || 'Paddle OCR failed';
            throw new Error(message);
          }
          const textResult = payload && typeof payload.text === 'string' ? payload.text : '';
          return textResult.trim();
        };

        const setPartsOcrStatus = (msg, isError = false) => {

          const section = findActivePartsSection();

          const statusEl = (section && section.querySelector('[data-parts-ocr-status]')) || partsOcrStatus;

          if (!statusEl) return;

          statusEl.textContent = msg || '';

          statusEl.style.color = isError ? '#c1121f' : '#475569';

        };



        const parseOcrText = (text) => {

          const STOP_WORDS = new Set([

            'DATE',

            'TIME',

            'TOTAL',

            'PRICE',

            'CASH',

            'EUR',

            'USD',

            'TAX',

            'QTY',

            'ITEM',

            'SN',

            'S/N',

            'SERIAL',

            'MODEL',

            'REF',

            'ORDER',

          ]);



          const lines = text

            .split('\n')

            .map((l) => l.trim())

            .filter(Boolean);


          const regexModelCandidate = (() => {
            const m1 = text.match(/FA\d+[A-Z0-9]*/i);
            if (m1) return m1[0].toUpperCase();
            const m2 = text.match(/LED-[A-Z0-9]+/i);
            if (m2) return m2[0].toUpperCase();
            return '';
          })();



          const normalizeToken = (t) =>

            t

              .replace(/[^A-Za-z0-9/-]/g, ' ')

              .replace(/\s+/g, ' ')

              .trim();



          const rawTokens = text

            .split(/\s+/)

            .map(normalizeToken)

            .map((t) => t.replace(/\s+/g, ''))

            .filter(Boolean);



          const tokens = rawTokens.map((t) => t.toUpperCase());
          const tokensWithCombos = [...tokens];
          for (let i = 0; i < tokens.length - 1; i += 1) {
            const joined = tokens[i] + tokens[i + 1];
            if (
              joined.length >= 7 &&
              joined.length <= 24 &&
              /[A-Z]/.test(joined) &&
              /[0-9]/.test(joined)
            ) {
              tokensWithCombos.push(joined);
            }
          }



          const tokenScore = (value) => {

            const v = value || '';

            if (STOP_WORDS.has(v)) return -5;

            let score = 0;

            if (/[A-Z]/.test(v) && /[0-9]/.test(v)) score += 4;

            if (v.includes('-') || v.includes('/')) score += 1;

            if (v.length >= 6 && v.length <= 18) score += 3;

            if (v.length > 18) score -= 2;

            if (v.length < 5) score -= 2;

            const uniqueChars = new Set(v.split(''));

            score += Math.min(uniqueChars.size, 5) * 0.2;

            return score;

          };



          const looksLikeModel = (value) => {

            if (!value) return false;

            if (/^LED-[A-Z0-9]{3,}$/i.test(value)) return true;

            if (/^FA\d+[A-Z0-9]*$/i.test(value)) return true;

            return false;

          };



          const scoredTokens = tokensWithCombos

            .map((t, idx) => ({ t, idx, score: tokenScore(t) }))

            .filter((s) => s.score > 0)

            .sort((a, b) => b.score - a.score);



          let model = '';

          let modelIndex = -1;

          const modelCandidate = scoredTokens.find((s) => looksLikeModel(s.t));

          if (regexModelCandidate) {

            model = regexModelCandidate;

            modelIndex = tokens.findIndex((t) => t.includes(regexModelCandidate));

          } else if (modelCandidate) {

            model = modelCandidate.t;

            modelIndex = modelCandidate.idx;

          } else {

            const lineModel = lines

              .map((l) => normalizeToken(l).toUpperCase())

              .find((l) => looksLikeModel(l.replace(/\s+/g, '')));

            if (lineModel) model = lineModel.replace(/\s+/g, '');

          }

          const serialRegexes = [
            /\b\d{2}[A-Z0-9]{6,18}T?\b/,
            /\b\d{8,10}T?\b/,
          ];

          const pickSerialFromRegex = (values) => {
            const candidates = [];
            values.forEach((value) => {
              serialRegexes.forEach((regex) => {
                const match = String(value || '').toUpperCase().match(regex);
                if (match && match[0]) candidates.push(match[0]);
              });
            });
            if (!candidates.length) return '';
            const unique = Array.from(new Set(candidates));
            const withTrailingT = unique.filter((v) => v.endsWith('T'));
            const pool = withTrailingT.length ? withTrailingT : unique;
            pool.sort((a, b) => b.length - a.length);
            return pool[0];
          };

          const regexSerial = pickSerialFromRegex(tokensWithCombos);



          const pickSerial = (list, startIdx = 0) => {

            const candidates = list.filter(

              (s) =>

                s.idx >= startIdx &&

                /[0-9]/.test(s.t) &&

                s.t.replace(/[^A-Z0-9]/gi, '').length >= 7,

            );

            if (!candidates.length) return '';

            return candidates[0].t;

          };



          let serialCandidate = regexSerial || pickSerial(scoredTokens, modelIndex >= 0 ? modelIndex + 1 : 0);

          if (!serialCandidate) serialCandidate = pickSerial(scoredTokens, 0);



          const extractBatch = (serial) => {

            if (!serial) return '';

            const cleaned = serial.replace(/[^A-Z0-9]/gi, '').toUpperCase();

            const letterDigit3 = cleaned.match(/[A-Z][0-9]{2}/);

            if (letterDigit3) return letterDigit3[0];

            const digitLetter2 = cleaned.match(/[0-9]{2}[A-Z]/);

            if (digitLetter2) return digitLetter2[0];

            const digitsOnly = cleaned.replace(/[^0-9]/g, '');
            if (digitsOnly.length >= 8 && digitsOnly.length <= 12) {
              return digitsOnly.slice(2, 5);
            }

            if (digitsOnly.length >= 3) {

              const midStart = Math.max(0, Math.floor(digitsOnly.length / 2) - 1);

              return digitsOnly.slice(midStart, midStart + 3);

            }



            if (cleaned.length >= 5) return cleaned.slice(0, 5);

            if (cleaned.length >= 3) return cleaned.slice(0, 3);

            return '';

          };



          const batch = extractBatch(serialCandidate);



          const topCandidates = scoredTokens.slice(0, 3).map((c) => c.t);



          return { model, serial: serialCandidate, batch, candidates: topCandidates };

        };



        const fillPartsFromOcr = (parsed) => {

          const row = findFirstVisiblePartsRow();

          if (!row) return false;

          const formType = formTypeSelectEl ? formTypeSelectEl.value : '';

          const isServiceForm = formType === 'service_report';

          const safeModel = parsed.model || '';

          const safeBatch = parsed.batch || '';

          const safeSerial = parsed.serial || '';

          const combinedModelBatch = safeModel && safeBatch ? safeModel + '/' + safeBatch : safeModel;

          if (isServiceForm) {

            const partInput = row.querySelector('input[name^="parts_used_part_"]');

            if (partInput && combinedModelBatch) partInput.value = combinedModelBatch;

            const descInput = row.querySelector('input[name^="parts_removed_desc_"]');

            if (descInput && safeSerial && !descInput.value.trim()) descInput.value = safeSerial;

            const reasonInput = row.querySelector('input[name^="parts_used_serial_"]');

            if (reasonInput && safeSerial && !reasonInput.value.trim() && !descInput?.value.trim()) {

              reasonInput.value = safeSerial;

            }

          } else {

            if (parsed.serial) {

              const serialInput = row.querySelector('input[name^="parts_used_serial_"]');

              if (serialInput) serialInput.value = safeSerial;

            }

            if (parsed.model) {

              const partInput = row.querySelector('input[name^="parts_used_part_"]');

              if (partInput) partInput.value = safeModel;

            }

            const batchDescInput = row.querySelector('input[name^="parts_removed_desc_"]');

            if (safeBatch && batchDescInput && !batchDescInput.value.trim()) {

              batchDescInput.value = safeBatch;

            }

          }

          const ledField = document.querySelector('input[name="led_display_model"]');

          const combined = safeModel && safeBatch ? safeModel + '/' + safeBatch : safeModel || '';

          if (ledField && combined) {

            const current = ledField.value ? ledField.value.split(',').map((s) => s.trim()).filter(Boolean) : [];

            const normalizedCombined = combined.toUpperCase();

            const have = new Set(current.map((s) => s.toUpperCase()));

            if (!have.has(normalizedCombined)) {

              current.push(combined);

              ledField.value = current.join(', ');

            }

          }

          return true;

        };


        const isLikelySerialBarcode = (value) => {
          if (!value) return false;
          const cleaned = String(value).replace(/[^A-Z0-9]/gi, '').toUpperCase();
          if (cleaned.length < 8 || cleaned.length > 24) return false;
          if (!/[A-Z]/.test(cleaned) || !/[0-9]/.test(cleaned)) return false;
          const longPattern = /^d{2}[A-Z0-9]{6,}$/;
          const shortPattern = /^d{8,12}T?$/;
          return longPattern.test(cleaned) || shortPattern.test(cleaned);
        };




        const disableBarcodeOcr = true;

        const handlePartsOcrFile = async (file) => {
          if (!file) return;
          setPartsOcrStatus('Reading photo...');
          let dataUrl = '';
          try {
            if (!disableBarcodeOcr) {
              // Try barcode decoding first (more reliable for serial stickers).
              try {
                setPartsOcrStatus('Checking barcode...');
                const ZXing = await loadZxing();
                dataUrl = dataUrl || (await readFileAsDataUrl(file));
                const reader = new ZXing.BrowserBarcodeReader();
                const result = await reader.decodeFromImageUrl(dataUrl);
                if (result && result.text) {
                  const barcode = String(result.text).trim();
                  if (isLikelySerialBarcode(barcode)) {
                    fillPartsFromOcr({ model: '', serial: barcode, batch: '', candidates: [barcode] });
                    setPartsOcrStatus('Barcode decoded: ' + barcode + '. Check and edit if needed.');
                    return;
                  }
                  recordDebug('parts-ocr-barcode-skip', { barcode });
                  setPartsOcrStatus('Barcode looks incorrect. Switching to OCR...');
                }
              } catch (barcodeErr) {
                // Fallback silently to OCR
                recordDebug('parts-ocr-barcode-error', {
                  error: String(barcodeErr && barcodeErr.message ? barcodeErr.message : barcodeErr),
                });
              }
            }

            // Paddle OCR as next fallback (better for noisy images).
            try {
              setPartsOcrStatus('Recognizing text (Paddle OCR)...');
              dataUrl = dataUrl || (await readFileAsDataUrl(file));
              const paddleText = await callPaddleOcr(dataUrl);
              if (paddleText) {
                const parsedPaddle = parseOcrText(paddleText);
                if (parsedPaddle.serial || parsedPaddle.model) {
                  fillPartsFromOcr(parsedPaddle);
                  const summary =
                    'OCR ok (Paddle). Serial: ' +
                    (parsedPaddle.serial || 'n/a') +
                    '; Model: ' +
                    (parsedPaddle.model || 'n/a') +
                    '; Batch: ' +
                    (parsedPaddle.batch || 'n/a') +
                    '; Top tokens: ' +
                    (parsedPaddle.candidates && parsedPaddle.candidates.length
                      ? parsedPaddle.candidates.join(', ')
                      : 'n/a') +
                    '. Check and edit if needed.';
                  setPartsOcrStatus(summary);
                  return;
                }
              }
            } catch (paddleErr) {
              recordDebug('parts-ocr-paddle-error', {
                error: String(paddleErr && paddleErr.message ? paddleErr.message : paddleErr),
              });
            }

            const Tesseract = await loadTesseract();
            setPartsOcrStatus('Recognizing text...');
            const { data } = await Tesseract.recognize(file, 'eng', {
              tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/ ',
              tessedit_pageseg_mode: 6,
            });
            const parsed = parseOcrText(data.text || '');
            if (!parsed.serial && !parsed.model) {
              setPartsOcrStatus('No text found, please try a clearer photo.', true);
              return;
            }
            fillPartsFromOcr(parsed);
            const summary =
              'OCR ok. Serial: ' +
              (parsed.serial || 'n/a') +
              '; Model: ' +
              (parsed.model || 'n/a') +
              '; Batch: ' +
              (parsed.batch || 'n/a') +
              '; Top tokens: ' +
              (parsed.candidates && parsed.candidates.length ? parsed.candidates.join(', ') : 'n/a') +
              '. Check and edit if needed.';
            setPartsOcrStatus(summary);
          } catch (err) {
            setPartsOcrStatus(err.message || 'OCR failed.', true);
          } finally {
            if (partsOcrInput) partsOcrInput.value = '';
          }
        };

        const adminPreviewEl = adminSectionEl ? adminSectionEl.querySelector('[data-admin-preview]') : null;

        const adminPreviewLabelEl = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-preview-label]')

          : null;

        const adminPreviewFrameWrapper = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-preview-frame-wrapper]')

          : null;

        const adminPreviewCanvas = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-preview-canvas]')

          : null;

        const adminPreviewEmptyEl = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-preview-empty]')

          : null;

        const adminPreviewOverlayEl = adminSectionEl

          ? adminSectionEl.querySelector('[data-template-overlay]')

          : null;

        const adminPreviewBoundaryEl = adminSectionEl

          ? adminSectionEl.querySelector('[data-template-boundary-line]')

          : null;



        const boundaryControlsEl = adminSectionEl

          ? adminSectionEl.querySelector('[data-boundary-controls]')

          : null;

        const boundaryRangeInput = boundaryControlsEl

          ? boundaryControlsEl.querySelector('[data-boundary-range]')

          : null;

        const boundaryNumberInput = boundaryControlsEl

          ? boundaryControlsEl.querySelector('[data-boundary-input]')

          : null;

        const boundarySaveBtn = boundaryControlsEl

          ? boundaryControlsEl.querySelector('[data-boundary-save]')

          : null;

        const adminStatusEl = adminSectionEl ? adminSectionEl.querySelector('[data-admin-status]') : null;

        const adminProfileEl = adminSectionEl ? adminSectionEl.querySelector('[data-admin-profile]') : null;

        const DEFAULT_PAGE_WIDTH = 595.28;

        const BOUNDARY_DEFAULT_HEIGHT = 841.89;

        const urlSearchParams = new URL(window.location.href).searchParams;

        const requestedTemplateSlug = (urlSearchParams.get('template') || '').trim().toLowerCase();

        const requestedTemplateId = (urlSearchParams.get('templateId') || '').trim();

        const requestedAdminWindow = urlSearchParams.get('adminWindow') === '1';

        const boundaryState = {

          templateId: null,

          pageWidth: DEFAULT_PAGE_WIDTH,

          pageHeight: BOUNDARY_DEFAULT_HEIGHT,

          value: 0,

          dirty: false,

        };

        let adminWindowOpened = requestedAdminWindow;

        const openStandaloneAdminWindow = () => {

          const adminUrl = new URL(window.location.href);

          adminUrl.searchParams.set('adminWindow', '1');

          adminUrl.hash = '';

          window.open(adminUrl.toString(), '_blank', 'noopener');

        };

        let boundaryOverlayFrame = null;

        let previewResizeObserver = null;

        const clampValue = (value, min, max) => {

          const number = Number(value);

          if (!Number.isFinite(number)) return min;

          if (number < min) return min;

          if (number > max) return max;

          return number;

        };

        const defaultBoundaryFromHeight = (height) => {

          const safeHeight = Number.isFinite(height) && height > 0 ? height : BOUNDARY_DEFAULT_HEIGHT;

          return clampValue(safeHeight * 0.22, 0, Math.max(safeHeight - 40, 0));

        };

        const templateState = {

          templates: [],

          activeTemplateId: null,

        };

        const ADMIN_TOKEN_KEY = 'pm-admin-token';

        let adminTokenStore = null;

        try {

          adminTokenStore = window.localStorage;

        } catch (err) {

          adminTokenStore = null;

        }

        if (adminTemplateListEl) {

          adminTemplateListEl.innerHTML =

            '<div style="padding:0.75rem;color:#475569;">Log in to manage templates.</div>';

        }



        const appBaseUrl = new URL('.', window.location.href);

        const buildAppUrl = (path) => {

          const normalized = (path || '').replace(/^\/+/, '');

          return new URL(normalized || '.', appBaseUrl).toString();

        };



        const debounce = (fn, delay = 250) => {

          let timer = null;

          return (...args) => {

            if (timer) {

              window.clearTimeout(timer);

            }

            timer = window.setTimeout(() => fn(...args), delay);

          };

        };



        const projectFields = {

          batch_number: formEl.querySelector('input[name="batch_number"]'),

          end_customer_name: formEl.querySelector('input[name="end_customer_name"]'),

          site_location: formEl.querySelector('input[name="site_location"]'),

          led_display_model: formEl.querySelector('input[name="led_display_model"]'),

          date_of_service: formEl.querySelector('input[name="date_of_service"]'),

          service_company_name: formEl.querySelector('input[name="service_company_name"]'),

        };



        const projectStatusEl = (() => {

          const parentField = projectFields.batch_number ? projectFields.batch_number.closest('.field') : null;

          if (!parentField) return null;

          const hint = document.createElement('small');

          hint.className = 'field-hint project-status-hint';

          hint.style.color = '#475569';

          hint.style.fontWeight = '400';

          hint.style.marginTop = '-6px';

          hint.hidden = true;

          parentField.appendChild(hint);

          return hint;

        })();



        const updateProjectStatus = (message, isError = false) => {

          if (!projectStatusEl) return;

          projectStatusEl.textContent = message || '';

          projectStatusEl.hidden = !message;

          projectStatusEl.style.color = isError ? '#b91c1c' : '#475569';

        };



        const applyProjectCard = (card) => {

          if (!card || typeof card !== 'object') return;

          const mapping = {

            batch_number: card.batch_number || card.lsc_project_number || '',

            end_customer_name: card.end_customer_name,

            site_location: card.site_location,

            led_display_model: card.led_display_model,

            date_of_service: card.date_of_service,

            service_company_name: card.service_company_name,

          };

          Object.entries(mapping).forEach(([name, value]) => {

            const input = projectFields[name];

            if (!input || value === undefined || value === null) return;

            const next = String(value);

            if (input.value !== next) {

              input.value = next;

              input.dispatchEvent(new Event('input', { bubbles: true }));

            }

          });

        };



        const fetchProjectCard = (projectNumber) => {

          const key = (projectNumber || '').trim();

          if (!key) {

            updateProjectStatus('');

            return Promise.resolve(null);

          }

          updateProjectStatus('Loading saved project...');

          const url = buildAppUrl('projects/' + encodeURIComponent(key));

          return fetch(url)

            .then((response) => {

              if (response.status === 404) {

                const notFound = new Error('Not found');

                notFound.code = 'NOT_FOUND';

                throw notFound;

              }

              if (!response.ok) {

                throw new Error('Lookup failed');

              }

              return response.json();

            })

            .then((payload) => {

              if (payload && payload.ok && payload.project) {

                applyProjectCard(payload.project);

                updateProjectStatus('Loaded saved project data.');

                return payload.project;

              }

              throw new Error('Invalid response');

            })

            .catch((err) => {

              if (err && err.code === 'NOT_FOUND') {

                updateProjectStatus('No saved data for this project yet.', true);

                return null;

              }

              updateProjectStatus('Project lookup failed.', true);

              return null;

            });

        };



        const triggerProjectLookup = debounce(() => {

          const projectNumber = projectFields.batch_number ? projectFields.batch_number.value : '';

          const key = (projectNumber || '').trim();

          if (!key) {

            updateProjectStatus('');

            return;

          }

          fetchProjectCard(key);

        }, 350);



        if (projectFields.batch_number) {

          ['change', 'blur'].forEach((eventName) => {

            projectFields.batch_number.addEventListener(eventName, triggerProjectLookup);

          });

          const initialKey = (projectFields.batch_number.value || '').trim();

          if (initialKey) {

            triggerProjectLookup();

          }

        }



        const setTemplateStatus = (message, isError = false) => {

          if (!templateStatusEl) return;

          templateStatusEl.textContent = message || '';

          templateStatusEl.style.color = isError ? '#b91c1c' : '#475569';

        };



        const updateBoundaryControls = () => {

          if (!boundaryControlsEl) return;

          if (!boundaryState.templateId) {

            boundaryControlsEl.hidden = true;

            if (boundarySaveBtn) boundarySaveBtn.disabled = true;

            if (adminPreviewOverlayEl) adminPreviewOverlayEl.hidden = true;

            return;

          }

          boundaryControlsEl.hidden = false;

          const maxValue = Math.max(0, Math.round(boundaryState.pageHeight));

          if (boundaryRangeInput) {

            boundaryRangeInput.min = '0';

            boundaryRangeInput.max = String(maxValue);

            boundaryRangeInput.value = String(Math.round(boundaryState.value));

          }

          if (boundaryNumberInput) {

            boundaryNumberInput.min = '0';

            boundaryNumberInput.max = String(maxValue);

            boundaryNumberInput.value = String(Math.round(boundaryState.value));

          }

          if (boundarySaveBtn) {

            boundarySaveBtn.disabled = !boundaryState.dirty;

          }

        };



        const updateBoundaryOverlay = () => {

          if (

            !adminPreviewOverlayEl ||

            !adminPreviewBoundaryEl ||

            !adminPreviewFrameWrapper ||

            !boundaryState.templateId

          ) {

            if (adminPreviewOverlayEl) {

              adminPreviewOverlayEl.hidden = true;

            }

            return;

          }

          const wrapperRect = adminPreviewFrameWrapper.getBoundingClientRect();

          const canvasRect = adminPreviewCanvas ? adminPreviewCanvas.getBoundingClientRect() : null;

          const wrapperHeight = wrapperRect.height;

          const wrapperWidth = wrapperRect.width;

          const canvasHeight = canvasRect ? canvasRect.height : 0;

          const canvasWidth = canvasRect ? canvasRect.width : 0;

          if (

            !wrapperHeight ||

            !wrapperWidth ||

            !canvasHeight ||

            !canvasWidth ||

            !Number.isFinite(boundaryState.pageHeight) ||

            boundaryState.pageHeight <= 0 ||

            !Number.isFinite(boundaryState.pageWidth) ||

            boundaryState.pageWidth <= 0

          ) {

            adminPreviewOverlayEl.hidden = true;

            return;

          }

          const ratio = clampValue(boundaryState.value / boundaryState.pageHeight, 0, 1);

          const overlayTop = canvasRect.top - wrapperRect.top;

          const overlayLeft = canvasRect.left - wrapperRect.left;

          adminPreviewOverlayEl.style.top = overlayTop + 'px';

          adminPreviewOverlayEl.style.left = overlayLeft + 'px';

          adminPreviewOverlayEl.style.height = canvasHeight + 'px';

          adminPreviewOverlayEl.style.width = canvasWidth + 'px';

          const topPosition = overlayTop + canvasHeight * ratio;

          adminPreviewBoundaryEl.style.top = topPosition + 'px';

          adminPreviewOverlayEl.hidden = false;

        };



        const scheduleBoundaryOverlay = () => {

          if (boundaryOverlayFrame) {

            cancelAnimationFrame(boundaryOverlayFrame);

          }

          boundaryOverlayFrame = requestAnimationFrame(updateBoundaryOverlay);

        };



        const attachPreviewResizeObserver = () => {

          if (typeof ResizeObserver === 'undefined' || !adminPreviewFrameWrapper) {

            return;

          }

          if (previewResizeObserver) {

            previewResizeObserver.disconnect();

          }

          previewResizeObserver = new ResizeObserver(() => {

            scheduleBoundaryOverlay();

          });

          previewResizeObserver.observe(adminPreviewFrameWrapper);

        };

        attachPreviewResizeObserver();

        let previewRenderToken = 0;

        const renderTemplatePreview = async (previewUrl, template) => {

          if (!pdfjsLib || !adminPreviewCanvas) {

            return;

          }

          const token = ++previewRenderToken;

          try {

            const loadingTask = pdfjsLib.getDocument({ url: previewUrl });

            const pdf = await loadingTask.promise;

            const page = await pdf.getPage(1);

            const wrapperWidth = adminPreviewFrameWrapper ? adminPreviewFrameWrapper.clientWidth : 640;

            const viewport = page.getViewport({

              scale: Math.max(wrapperWidth / page.getViewport({ scale: 1 }).width, 1),

            });

            if (token !== previewRenderToken) {

              return;

            }

            const context = adminPreviewCanvas.getContext('2d');

            adminPreviewCanvas.width = viewport.width;

            adminPreviewCanvas.height = viewport.height;

            context.clearRect(0, 0, adminPreviewCanvas.width, adminPreviewCanvas.height);

            await page.render({ canvasContext: context, viewport }).promise;

            if (token !== previewRenderToken) {

              return;

            }

            boundaryState.pageWidth = viewport.width;

            boundaryState.pageHeight = viewport.height;

            scheduleBoundaryOverlay();

          } catch (err) {

            console.error('[admin] Failed to render preview', err);

            if (token === previewRenderToken && adminPreviewEmptyEl) {

              adminPreviewEmptyEl.hidden = false;

            }

          }

        };



        const setBoundaryTemplate = (template) => {

          if (!template) {

            boundaryState.templateId = null;

            boundaryState.pageHeight = BOUNDARY_DEFAULT_HEIGHT;

            boundaryState.pageWidth = DEFAULT_PAGE_WIDTH;

            boundaryState.value = 0;

            boundaryState.dirty = false;

            updateBoundaryControls();

            scheduleBoundaryOverlay();

            return;

          }

          boundaryState.templateId = template.id;

          boundaryState.pageWidth =

            Number.isFinite(template.pageWidth) && template.pageWidth > 0

              ? Number(template.pageWidth)

              : DEFAULT_PAGE_WIDTH;

          boundaryState.pageHeight =

            Number.isFinite(template.pageHeight) && template.pageHeight > 0

              ? Number(template.pageHeight)

              : BOUNDARY_DEFAULT_HEIGHT;

          const providedOffset =

            Number.isFinite(template.bodyTopOffset) && template.bodyTopOffset >= 0

              ? Number(template.bodyTopOffset)

              : defaultBoundaryFromHeight(boundaryState.pageHeight);

          boundaryState.value = clampValue(providedOffset, 0, boundaryState.pageHeight);

          boundaryState.dirty = false;

          updateBoundaryControls();

          scheduleBoundaryOverlay();

        };



        const handleBoundaryValueChange = (nextValue, source) => {

          if (!boundaryState.templateId) return;

          const clamped = clampValue(nextValue, 0, boundaryState.pageHeight);

          boundaryState.value = clamped;

          boundaryState.dirty = true;

          if (boundarySaveBtn) {

            boundarySaveBtn.disabled = false;

          }

          if (boundaryRangeInput && source !== 'range') {

            boundaryRangeInput.value = String(Math.round(clamped));

          }

          if (boundaryNumberInput && source !== 'number') {

            boundaryNumberInput.value = String(Math.round(clamped));

          }

          scheduleBoundaryOverlay();

        };



        const applyTemplateSelection = () => {

          if (!templateSelectEl) return;

          const selectedId = templateSelectEl.value;

          const selected =

            templateState.templates.find((tpl) => tpl.id === selectedId) || null;

          if (templateSlugInput) {

            templateSlugInput.value = selected && selected.slug ? selected.slug : '';

          }

          if (templateDescriptionEl) {

            if (selected && selected.description && selected.description.trim().length) {

              templateDescriptionEl.hidden = false;

              templateDescriptionEl.textContent = selected.description;

            } else {

              templateDescriptionEl.hidden = true;

              templateDescriptionEl.textContent = '';

            }

          }

          if (templatePreviewLink) {

            if (selected && selected.previewUrl) {

              const previewPath = selected.previewUrl.replace(/^\/+/, '');



              templatePreviewLink.href = buildAppUrl(previewPath);

              templatePreviewLink.hidden = false;

            } else {

              templatePreviewLink.hidden = true;

              templatePreviewLink.href = '#';

            }

          }

          if (selected) {

            const slugDisplay = selected.slug ? ' - ' + selected.slug : '';

            setTemplateStatus(

              (selected.label || selected.slug || 'Template') +

                slugDisplay +

                (selected.isActive ? ' - Active by default' : ''),

            );

          } else {

            setTemplateStatus('Select a template to continue.');

          }

        };



        const loadTemplateOptions = () => {

          if (!templateSelectEl) return;

          setTemplateStatus('Loading available templates...');

          templateSelectEl.disabled = true;

          templateSelectEl.innerHTML = '<option value="">Loading...</option>';

          fetch(buildAppUrl('api/templates'), { credentials: 'same-origin' })

            .then((response) => {

              if (!response.ok) {

                throw new Error('Failed to load templates.');

              }

              return response.json();

            })

            .then((payload) => {

              if (!payload || !Array.isArray(payload.templates)) {

                throw new Error('Template response malformed.');

              }

              templateState.templates = payload.templates;

              templateState.activeTemplateId = payload.activeTemplateId || '';

              templateSelectEl.innerHTML = '';

              if (!payload.templates.length) {

                const option = document.createElement('option');

                option.value = '';

                option.textContent = 'No templates found';

                templateSelectEl.appendChild(option);

                templateSelectEl.disabled = true;

                if (templateSlugInput) templateSlugInput.value = '';

                if (templateDescriptionEl) {

                  templateDescriptionEl.hidden = false;

                  templateDescriptionEl.textContent = 'Upload a template in the admin panel to continue.';

                }

                setTemplateStatus('Templates are not configured yet.', true);

                return;

              }

              payload.templates.forEach((tpl) => {

                const option = document.createElement('option');

                option.value = tpl.id;

                option.textContent = tpl.label || tpl.slug || tpl.id;

                templateSelectEl.appendChild(option);

              });

              let defaultTemplate = null;

              if (requestedTemplateSlug) {

                defaultTemplate = payload.templates.find(

                  (tpl) => (tpl.slug || '').toLowerCase() === requestedTemplateSlug,

                );

              }

              if (!defaultTemplate && requestedTemplateId) {

                defaultTemplate = payload.templates.find((tpl) => tpl.id === requestedTemplateId);

              }

              if (!defaultTemplate) {

                defaultTemplate =

                  payload.templates.find((tpl) => tpl.isActive) || payload.templates[0];

              }

              templateSelectEl.disabled = false;

              templateSelectEl.value = defaultTemplate ? defaultTemplate.id : payload.templates[0].id;

              applyTemplateSelection();

            })

            .catch((err) => {

              setTemplateStatus(err.message || 'Unable to load templates.', true);

              templateSelectEl.innerHTML = '<option value="">Templates unavailable</option>';

              templateSelectEl.disabled = true;

              if (templateSlugInput) templateSlugInput.value = '';

              if (templateDescriptionEl) templateDescriptionEl.hidden = true;

              if (templatePreviewLink) templatePreviewLink.hidden = true;

            });

        };



        const readJsonPayload = async (response) => {

          try {

            const text = await response.text();

            if (!text) return null;

            return JSON.parse(text);

          } catch (err) {

            return null;

          }

        };



        if (requestedAdminWindow) {

          document.body.dataset.adminWindow = 'true';

        }



        const adminState = {

          token: adminTokenStore ? adminTokenStore.getItem(ADMIN_TOKEN_KEY) || '' : '',

        };

         const pdfjsLib =

          (window.pdfjsLib || (window['pdfjs-dist/build/pdf'] ? window['pdfjs-dist/build/pdf'] : null)) || null;

        if (pdfjsLib && pdfjsLib.GlobalWorkerOptions) {

        pdfjsLib.GlobalWorkerOptions.workerSrc = '/service2/vendor/pdfjs/pdf.worker.min.js';

        }

        const adminUiState = {

          previewTemplateId: null,

        };

        if (templateSelectEl) {

          templateSelectEl.addEventListener('change', applyTemplateSelection);

          loadTemplateOptions();

        } else if (templateInfoEl) {

          setTemplateStatus('Template selector unavailable.', true);

        }



        if (boundaryRangeInput) {

          boundaryRangeInput.addEventListener('input', (event) => {

            handleBoundaryValueChange(Number(event.target.value), 'range');

          });

        }

        if (boundaryNumberInput) {

          boundaryNumberInput.addEventListener('input', (event) => {

            handleBoundaryValueChange(Number(event.target.value), 'number');

          });

        }

        if (boundarySaveBtn) {

          boundarySaveBtn.addEventListener('click', () => {

            if (!boundaryState.templateId) return;

            showAdminStatus('Saving boundary...');

            adminFetch('admin/templates/boundary', {

              method: 'POST',

              headers: { 'Content-Type': 'application/json' },

              body: JSON.stringify({

                templateId: boundaryState.templateId,

                bodyTopOffset: boundaryState.value,

              }),

            })

              .then((payload) => {

                boundaryState.dirty = false;

                if (boundarySaveBtn) boundarySaveBtn.disabled = true;

                adminUiState.previewTemplateId = boundaryState.templateId;

                showAdminStatus('Boundary updated.');

                renderAdminTemplates(payload);

              })

              .catch((err) => {

                showAdminStatus(err.message, true);

              });

          });

        }

        window.addEventListener('resize', () => scheduleBoundaryOverlay());



        const setAdminModalVisible = (visible) => {

          if (!adminModalEl) return;

          adminModalEl.hidden = !visible;

          if (visible) {

            document.body.dataset.adminModal = 'open';

            if (!requestedAdminWindow) {

              document.body.style.overflow = 'hidden';

            }

            if (adminState.token) {

              loadAdminTemplates();

            }

          } else {

            delete document.body.dataset.adminModal;

            if (!requestedAdminWindow) {

              document.body.style.overflow = '';

            }

          }

        };



        const canUseStandaloneAdminWindow = () => {

          return Boolean(adminState.token);

        };



        if (adminOpenBtn) {

          adminOpenBtn.addEventListener('click', () => {

            if (canUseStandaloneAdminWindow() && !requestedAdminWindow) {

              openStandaloneAdminWindow();

              return;

            }

            setAdminModalVisible(true);

          });

        }



        adminCloseButtons.forEach((btn) => {

          btn.addEventListener('click', () => setAdminModalVisible(false));

        });



        if (adminModalEl) {

          adminModalEl.addEventListener('click', (event) => {

            if (event.target === adminModalEl) {

              setAdminModalVisible(false);

            }

          });

        }



        if (adminDialogEl) {

          adminDialogEl.addEventListener('click', (event) => event.stopPropagation());

        }



        document.addEventListener('keydown', (event) => {

          if (event.key === 'Escape') {

            setAdminModalVisible(false);

          }

        });



        const setAdminToken = (token) => {

          adminState.token = token || '';

          if (adminTokenStore) {

            if (adminState.token) {

              adminTokenStore.setItem(ADMIN_TOKEN_KEY, adminState.token);

            } else {

              adminTokenStore.removeItem(ADMIN_TOKEN_KEY);

            }

          }

          updateAdminVisibility();

        };



        const showAdminStatus = (message, isError = false) => {

          if (!adminStatusEl) return;

          adminStatusEl.style.color = isError ? '#b91c1c' : '#0f172a';

          adminStatusEl.textContent = message || '';

        };



        const renderAdminProfile = (payload) => {

          if (!adminProfileEl) return;

          if (!payload || !payload.username) {

            adminProfileEl.textContent = '';

            return;

          }

          const updated = payload.passwordUpdatedAt

            ? new Date(payload.passwordUpdatedAt).toLocaleString()

            : 'unknown';

          adminProfileEl.textContent =

            'Logged in as ' + payload.username + '. Password updated ' + updated + '.';

        };



        const clearPreviewCanvas = () => {

          if (!adminPreviewCanvas) return;

          const ctx = adminPreviewCanvas.getContext('2d');

          ctx.clearRect(0, 0, adminPreviewCanvas.width, adminPreviewCanvas.height);

          adminPreviewCanvas.width = 0;

          adminPreviewCanvas.height = 0;

        };



        const showAdminPreview = (template) => {

          if (!adminPreviewEl || !adminPreviewLabelEl || !adminPreviewEmptyEl) return;

          if (!template) {

            adminPreviewEl.hidden = true;

            clearPreviewCanvas();

            adminPreviewEmptyEl.hidden = false;

            adminUiState.previewTemplateId = null;

            setBoundaryTemplate(null);

            return;

          }

          adminPreviewEl.hidden = false;

          const previewLabel = template.label || template.relativePath || template.id;

          adminPreviewLabelEl.textContent =

            'Template preview: ' + previewLabel + (template.slug ? ' (' + template.slug + ')' : '');

          const previewUrl = buildAppUrl('admin/templates/' + encodeURIComponent(template.id) + '/preview');

          adminPreviewEmptyEl.hidden = true;

          adminUiState.previewTemplateId = template.id;

          attachPreviewResizeObserver();

          setBoundaryTemplate(template);

          renderTemplatePreview(previewUrl, template);

        };



        const updateAdminVisibility = () => {

          if (!adminSectionEl) return;

          const isAuthed = Boolean(adminState.token);

          if (adminUnauthEl) adminUnauthEl.hidden = isAuthed;

          if (adminAuthEl) adminAuthEl.hidden = !isAuthed;

          if (!isAuthed) {

            if (adminStatusEl) adminStatusEl.textContent = '';

            if (adminProfileEl) adminProfileEl.textContent = '';

            if (adminTemplateListEl) {

              adminTemplateListEl.innerHTML =

                '<div style="padding:0.75rem;color:#475569;">Log in to manage templates.</div>';

            }

            showAdminPreview(null);

          }

        };



        const adminFetch = (relativePath, options = {}) => {

          if (!adminState.token) {

            const err = new Error('AUTH_REQUIRED');

            err.code = 'AUTH_REQUIRED';

            return Promise.reject(err);

          }

          const init = Object.assign({ headers: {}, credentials: 'same-origin' }, options);

          init.headers = Object.assign({}, init.headers, {

            Authorization: 'Bearer ' + adminState.token,

          });

          const targetUrl = buildAppUrl(relativePath || '');

          return fetch(targetUrl, init).then(async (response) => {

            const payload = await readJsonPayload(response);

            if (!response.ok) {

              if (response.status === 401) {

                setAdminToken('');

                const authErr = new Error('AUTH_REQUIRED');

                authErr.code = 'AUTH_REQUIRED';

                throw authErr;

              }

              const message = (payload && payload.error) || response.statusText || 'Request failed';

              throw new Error(message);

            }

            return payload;

          });

        };



        const refreshAdminProfile = () => {

          if (!adminState.token) return;

          adminFetch('admin/profile')

            .then((payload) => {

              renderAdminProfile(payload);

            })

            .catch((err) => {

              if (err && err.code === 'AUTH_REQUIRED') {

                showAdminStatus('Admin authentication required. Please log in.', true);

                return;

              }

              console.warn('[admin] profile refresh failed', err);

            });

        };



        const renderAdminTemplates = (payload) => {

          if (!adminTemplateListEl) return;

          if (!payload || !Array.isArray(payload.templates) || !payload.templates.length) {

            adminTemplateListEl.innerHTML =

              '<div style="padding:0.75rem;color:#475569;">No templates uploaded yet.</div>';

            showAdminPreview(null);

            return;

          }

          const table = document.createElement('table');

          const thead = document.createElement('thead');

          thead.innerHTML =

            '<tr><th>Template</th><th>Status</th><th style="width:160px;">Actions</th></tr>';

          table.appendChild(thead);

          const tbody = document.createElement('tbody');

          let previewCandidate = null;

          payload.templates.forEach((tpl) => {

            const row = document.createElement('tr');

            const colInfo = document.createElement('td');

            const nameSpan = document.createElement('span');

            nameSpan.className = 'admin-template__name';

            nameSpan.textContent = tpl.label || tpl.relativePath;

            const meta = document.createElement('span');

            meta.className = 'admin-template__meta';

            const size = tpl.size ? (tpl.size / 1024 / 1024).toFixed(2) + ' MB' : 'Unknown size';

            const uploaded = tpl.uploadedAt ? new Date(tpl.uploadedAt).toLocaleString() : 'Unknown date';

            meta.textContent = size + ' â€¢ ' + uploaded;

            colInfo.appendChild(nameSpan);

            colInfo.appendChild(meta);

            if (tpl.slug) {

              const slugInfo = document.createElement('span');

              slugInfo.className = 'admin-template__slug';

              slugInfo.textContent = 'Slug: ' + tpl.slug;

              colInfo.appendChild(slugInfo);

            }

            if (tpl.description) {

              const desc = document.createElement('p');

              desc.className = 'admin-template__desc';

              desc.textContent = tpl.description;

              colInfo.appendChild(desc);

            }



            const colStatus = document.createElement('td');

            if (tpl.id === payload.activeTemplateId) {

              const badge = document.createElement('span');

              badge.className = 'admin-badge';

              badge.textContent = 'Active';

              colStatus.appendChild(badge);

            } else {

              colStatus.textContent = 'Available';

            }



            const colActions = document.createElement('td');

            colActions.className = 'admin-template__actions';

            const downloadLink = document.createElement('a');

            const relativeHref = (tpl.relativePath || '').replace(/\\/g, '/');

            downloadLink.href = buildAppUrl(relativeHref);

            downloadLink.textContent = 'Download';

            downloadLink.target = '_blank';

            downloadLink.rel = 'noopener noreferrer';

            colActions.appendChild(downloadLink);



            const previewBtn = document.createElement('button');

            previewBtn.type = 'button';

            previewBtn.className = 'link-button';

            previewBtn.textContent = 'Preview';

            previewBtn.addEventListener('click', (event) => {

              event.stopPropagation();

              showAdminPreview(tpl);

            });

            colActions.appendChild(previewBtn);



            const selectBtn = document.createElement('button');

            selectBtn.type = 'button';

            selectBtn.className = 'link-button';

            selectBtn.textContent = tpl.id === payload.activeTemplateId ? 'Current' : 'Activate';

            selectBtn.disabled = tpl.id === payload.activeTemplateId;

            if (tpl.id !== payload.activeTemplateId) {

              selectBtn.addEventListener('click', () => selectAdminTemplate(tpl.id));

            }

            colActions.appendChild(selectBtn);



            const deleteBtn = document.createElement('button');

            deleteBtn.type = 'button';

            deleteBtn.className = 'link-button danger';

            deleteBtn.textContent = 'Delete';

            if (tpl.source === 'builtin') {

              deleteBtn.disabled = true;

              deleteBtn.title = 'Builtin template cannot be deleted';

            } else {

              deleteBtn.addEventListener('click', () => {

                const proceed = window.confirm(

                  'Delete template "' + (tpl.label || tpl.slug || tpl.id) + '"? This cannot be undone.',

                );

                if (!proceed) return;

                deleteAdminTemplate(tpl.id);

              });

            }

            colActions.appendChild(deleteBtn);



            row.appendChild(colInfo);

            row.appendChild(colStatus);

            row.appendChild(colActions);

            tbody.appendChild(row);



            if (!previewCandidate) {

              if (adminUiState.previewTemplateId && adminUiState.previewTemplateId === tpl.id) {

                previewCandidate = tpl;

              } else if (tpl.id === payload.activeTemplateId) {

                previewCandidate = tpl;

              }

            }

          });

          table.appendChild(tbody);

          adminTemplateListEl.innerHTML = '';

          adminTemplateListEl.appendChild(table);

          if (!previewCandidate) {

            previewCandidate = payload.templates[0];

          }

          showAdminPreview(previewCandidate);

        };



        const loadAdminTemplates = () => {

          if (!adminState.token) {

            if (adminTemplateListEl) {

              adminTemplateListEl.innerHTML =

                '<div style="padding:0.75rem;color:#475569;">Log in to manage templates.</div>';

            }

            return;

          }

          adminFetch('admin/templates')

            .then((payload) => {

              renderAdminTemplates(payload);

            })

            .catch((err) => {

              if (err && err.code === 'AUTH_REQUIRED') {

                showAdminStatus('Admin authentication required. Please log in.', true);

                return;

              }

              showAdminStatus(err.message, true);

            });

        };



        const selectAdminTemplate = (templateId) => {

          if (!templateId) return;

          showAdminStatus('Activating template...');

          adminFetch('admin/templates/select', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ templateId }),

          })

            .then((payload) => {

              showAdminStatus('Template activated.');

              adminUiState.previewTemplateId = payload.activeTemplateId || templateId;

              renderAdminTemplates(payload);

            })

            .catch((err) => {

              showAdminStatus(err.message, true);

            });

        };



        const deleteAdminTemplate = (templateId) => {

          if (!templateId) return;

          showAdminStatus('Deleting template...');

          adminFetch('admin/templates/delete', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ templateId }),

          })

            .then((payload) => {

              showAdminStatus('Template deleted.');

              renderAdminTemplates(payload);

            })

            .catch((err) => {

              showAdminStatus(err.message || 'Unable to delete template.', true);

            });

        };



        if (adminLoginForm) {

          adminLoginForm.addEventListener('submit', (event) => {

            event.preventDefault();

            if (!adminPasswordInput || !adminPasswordInput.value) {

              showAdminStatus('Enter the admin password.', true);

              return;

            }

            const password = adminPasswordInput.value;

            showAdminStatus('Signing in...');

            fetch(buildAppUrl('admin/login'), {

              method: 'POST',

              headers: { 'Content-Type': 'application/json' },

              credentials: 'same-origin',

              body: JSON.stringify({ password }),

            })

              .then(readJsonPayload)

              .then((payload) => {

                if (!payload || !payload.token) {

                  throw new Error('Unexpected response.');

                }

                adminPasswordInput.value = '';

                if (adminLoginErrorEl) adminLoginErrorEl.textContent = '';

                setAdminToken(payload.token);

                showAdminStatus('Logged in.');

                if (!adminWindowOpened) {

                  openStandaloneAdminWindow();

                  adminWindowOpened = true;

                }

                if (payload.username) {

                  renderAdminProfile(payload);

                } else {

                  refreshAdminProfile();

                }

                loadAdminTemplates();

              })

              .catch((err) => {

                if (adminLoginErrorEl) adminLoginErrorEl.textContent = err.message || 'Login failed.';

                showAdminStatus(err.message || 'Login failed.', true);

              });

          });

        }



        if (adminLogoutBtn) {

          adminLogoutBtn.addEventListener('click', () => {

            setAdminToken('');

            showAdminStatus('Logged out.');

            if (adminTemplateListEl) {

              adminTemplateListEl.innerHTML =

                '<div style="padding:0.75rem;color:#475569;">Log in to manage templates.</div>';

            }

          });

        }



        if (adminPasswordForm) {

          adminPasswordForm.addEventListener('submit', (event) => {

            event.preventDefault();

            if (!adminPasswordCurrentInput || !adminPasswordNewInput) return;

            const currentPassword = adminPasswordCurrentInput.value;

            const newPassword = adminPasswordNewInput.value;

            if (!newPassword || newPassword.length < 4) {

              showAdminStatus('New password must be at least 4 characters.', true);

              return;

            }

            showAdminStatus('Updating password...');

            adminFetch('admin/password', {

              method: 'POST',

              headers: { 'Content-Type': 'application/json' },

              body: JSON.stringify({ currentPassword, newPassword }),

            })

              .then(() => {

                adminPasswordCurrentInput.value = '';

                adminPasswordNewInput.value = '';

                setAdminToken('');

                showAdminStatus('Password updated. Please log in again.');

              })

              .catch((err) => {

                showAdminStatus(err.message || 'Password update failed.', true);

              });

          });

        }



        if (adminUploadForm) {

          adminUploadForm.addEventListener('submit', (event) => {

            event.preventDefault();

            if (!adminUploadInput || !adminUploadInput.files || !adminUploadInput.files[0]) {

              showAdminStatus('Choose a PDF file to upload.', true);

              return;

            }

            const formData = new FormData(adminUploadForm);

            showAdminStatus('Uploading template...');

            adminFetch('admin/templates/upload', {

              method: 'POST',

              body: formData,

            })

              .then((payload) => {

                adminUploadInput.value = '';

                if (adminUploadLabelInput) adminUploadLabelInput.value = '';

                if (adminUploadDescriptionInput) adminUploadDescriptionInput.value = '';

                showAdminStatus('Template uploaded and activated.');

                adminUiState.previewTemplateId = payload.activeTemplateId;

                renderAdminTemplates(payload);

              })

              .catch((err) => {

                showAdminStatus(err.message, true);

              });

          });

        }



        updateAdminVisibility();

        if (requestedAdminWindow) {

          setAdminModalVisible(true);

        }

        if (adminState.token) {

          refreshAdminProfile();

          loadAdminTemplates();

        }



        const selectedFiles = new Map();

        const previewUrls = new Map();

        debugState = { enabled: false, timeline: [] };

        const DATETIME_TEXT_SELECTOR = '[data-datetime-text]';

        const TIME_INPUT_SELECTOR = 'input[data-datetime-part="time"]';

        const TIME_PRESET_LIST_ID = 'time-presets';

        const TIME_PRESET_STEP_MINUTES = 15;

        const TIME_VALUE_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

        const endCustomerInput = document.getElementById('end-customer-name');

        const customerNameInput = document.getElementById('customer-name');

        const customerNameSync = { manual: false };

        const serviceCompanyInput = document.getElementById('service-company-name');

        const engineerCompanyInput = document.getElementById('engineer-company');

        const customerCompanyInput = document.getElementById('customer-company');

        const customerRepresentativeInput = document.getElementById('customer-representative');

        const attendeeClientHidden = document.getElementById('attendee-client-hidden');

        const signatureCompanySync = { engineerManual: false, customerManual: false };



        const syncCustomerNameFromSite = () => {

          if (!endCustomerInput || !customerNameInput) return;

          if (customerNameSync.manual) {

            return;

          }

          customerNameInput.value = endCustomerInput.value.trim();

        };



        if (endCustomerInput && customerNameInput) {

          syncCustomerNameFromSite();

          ['input', 'change'].forEach((eventName) => {

            endCustomerInput.addEventListener(eventName, () => {

              if (!customerNameSync.manual || !customerNameInput.value.trim()) {

                if (!customerNameInput.value.trim()) {

                  customerNameSync.manual = false;

                }

                syncCustomerNameFromSite();

              }

            });

          });

          customerNameInput.addEventListener('input', () => {

            const current = customerNameInput.value.trim();

            const source = endCustomerInput.value.trim();

            if (!current) {

              customerNameSync.manual = false;

              syncCustomerNameFromSite();

              return;

            }

            customerNameSync.manual = current !== source;

          });

        }



        const syncEngineerCompanyFromService = () => {

          if (!serviceCompanyInput || !engineerCompanyInput) return;

          if (signatureCompanySync.engineerManual) return;

          engineerCompanyInput.value = serviceCompanyInput.value.trim();

        };



        const syncCustomerCompanyFromHeader = () => {

          if (!endCustomerInput || !customerCompanyInput) return;

          if (signatureCompanySync.customerManual) return;

          customerCompanyInput.value = endCustomerInput.value.trim();

        };



        if (serviceCompanyInput && engineerCompanyInput) {

          syncEngineerCompanyFromService();

          ['input', 'change'].forEach((eventName) => {

            serviceCompanyInput.addEventListener(eventName, () => {

              if (!signatureCompanySync.engineerManual || !engineerCompanyInput.value.trim()) {

                if (!engineerCompanyInput.value.trim()) {

                  signatureCompanySync.engineerManual = false;

                }

                syncEngineerCompanyFromService();

              }

            });

          });

          engineerCompanyInput.addEventListener('input', () => {

            const current = engineerCompanyInput.value.trim();

            const source = serviceCompanyInput.value.trim();

            if (!current) {

              signatureCompanySync.engineerManual = false;

              syncEngineerCompanyFromService();

              return;

            }

            signatureCompanySync.engineerManual = current !== source;

          });

        }



        if (endCustomerInput && customerCompanyInput) {

          syncCustomerCompanyFromHeader();

          ['input', 'change'].forEach((eventName) => {

            endCustomerInput.addEventListener(eventName, () => {

              if (!signatureCompanySync.customerManual || !customerCompanyInput.value.trim()) {

                if (!customerCompanyInput.value.trim()) {

                  signatureCompanySync.customerManual = false;

                }

                syncCustomerCompanyFromHeader();

              }

            });

          });

          customerCompanyInput.addEventListener('input', () => {

            const current = customerCompanyInput.value.trim();

            const source = endCustomerInput.value.trim();

            if (!current) {

              signatureCompanySync.customerManual = false;

              syncCustomerCompanyFromHeader();

              return;

            }

            signatureCompanySync.customerManual = current !== source;

          });

        }

        const syncCustomerRepToSignature = () => {
          if (attendeeClientHidden) {
            attendeeClientHidden.value = (customerRepresentativeInput && customerRepresentativeInput.value.trim()) || '';
          }
        };

        if (customerRepresentativeInput) {
          ['input', 'change'].forEach((eventName) => {
            customerRepresentativeInput.addEventListener(eventName, syncCustomerRepToSignature);
          });
          syncCustomerRepToSignature();
        }

        const clampNumber = (value, min, max) => {

          if (!Number.isFinite(value)) return min;

          return Math.min(max, Math.max(min, value));

        };



        const pad2 = (value) => {

          const numeric = Number.isFinite(value) ? Math.trunc(value) : 0;

          const clamped = clampNumber(numeric, 0, 99);

          return String(clamped).padStart(2, '0');

        };



        const ensureTimePresetList = () => {

          let listEl = document.getElementById(TIME_PRESET_LIST_ID);

          if (listEl) {

            return TIME_PRESET_LIST_ID;

          }

          listEl = document.createElement('datalist');

          listEl.id = TIME_PRESET_LIST_ID;

          for (let hour = 0; hour < 24; hour += 1) {

            for (let minute = 0; minute < 60; minute += TIME_PRESET_STEP_MINUTES) {

              const option = document.createElement('option');

              option.value = pad2(hour) + ':' + pad2(minute);

              listEl.appendChild(option);

            }

          }

          if (formEl && formEl.parentNode) {

            formEl.parentNode.insertBefore(listEl, formEl.nextSibling);

          } else {

            document.body.appendChild(listEl);

          }

          return TIME_PRESET_LIST_ID;

        };



        const formatTimeDraft = (raw) => {

          if (typeof raw !== 'string') return '';

          const digits = raw.replace(/\D/g, '').slice(0, 4);

          if (!digits) return '';

          if (digits.length <= 2) {

            return digits;

          }

          if (digits.length === 3) {

            return digits.slice(0, 1) + ':' + digits.slice(1);

          }

          return digits.slice(0, 2) + ':' + digits.slice(2);

        };



        const normalizeTimeInputValue = (raw) => {

          if (typeof raw !== 'string') return '';

          const digits = raw.replace(/\D/g, '').slice(0, 4);

          if (!digits) return '';

          let hours = '';

          let minutes = '';

          if (digits.length === 1) {

            hours = '0' + digits;

            minutes = '00';

          } else if (digits.length === 2) {

            hours = digits;

            minutes = '00';

          } else if (digits.length === 3) {

            hours = digits.slice(0, 1);

            minutes = digits.slice(1);

          } else {

            hours = digits.slice(0, 2);

            minutes = digits.slice(2);

          }

          const hourNum = clampNumber(Number(hours), 0, 23);

          const minuteNum = clampNumber(Number(minutes), 0, 59);

          return pad2(hourNum) + ':' + pad2(minuteNum);

        };



        const applyTimeInputBehavior = (input) => {

          if (!input || input.dataset.timeFormatterApplied === '1') return;

          input.dataset.timeFormatterApplied = '1';

          input.type = 'text';

          input.setAttribute('inputmode', 'numeric');

          input.setAttribute('pattern', '[0-2][0-9]:[0-5][0-9]');

          input.setAttribute('title', 'Use 24-hour format HH:MM');

          if (!input.getAttribute('placeholder')) {

            input.setAttribute('placeholder', 'HH:MM');

          }

          input.setAttribute('autocomplete', 'off');

          const listId = ensureTimePresetList();

          if (listId) {

            input.setAttribute('list', listId);

          }

          const commitIfChanged = () => {

            const current = input.value.trim();

            if (input.dataset.timeCommittedValue === current) return;

            input.dataset.timeCommittedValue = current;

            input.dispatchEvent(new Event('change', { bubbles: true }));

          };

          const enforce = () => {

            const trimmed = input.value.trim();

            if (!trimmed) {

              input.classList.remove('is-invalid');

              input.setCustomValidity('');

              input.value = '';

              commitIfChanged();

              return;

            }

            const normalized = normalizeTimeInputValue(trimmed);

            if (!TIME_VALUE_REGEX.test(normalized)) {

              input.classList.add('is-invalid');

              input.setCustomValidity('Use 24-hour format HH:MM');

              input.value = normalized;

            } else {

              input.classList.remove('is-invalid');

              input.setCustomValidity('');

              input.value = normalized;

              commitIfChanged();

            }

          };

          input.addEventListener('input', () => {

            const draft = formatTimeDraft(input.value);

            input.value = draft;

            if (!draft) {

              input.classList.remove('is-invalid');

              input.setCustomValidity('');

              commitIfChanged();

              return;

            }

            if (TIME_VALUE_REGEX.test(draft)) {

              input.classList.remove('is-invalid');

              input.setCustomValidity('');

              commitIfChanged();

            }

          });

          input.addEventListener('blur', () => {

            enforce();

          });

          input.addEventListener('keydown', (event) => {

            if (event.key === 'Enter') {

              event.preventDefault();

              enforce();

            }

          });

          input.addEventListener('focus', () => {

            requestAnimationFrame(() => {

              try {

                input.select();

              } catch (err) {

                /* ignore selection failures */

              }

            });

          });

          const initial = normalizeTimeInputValue(input.value || '');

          if (initial && TIME_VALUE_REGEX.test(initial)) {

            input.value = initial;

            input.dataset.timeCommittedValue = initial;

          } else {

            input.dataset.timeCommittedValue = (input.value || '').trim();

          }

        };



        const normalizeDateTimeText = (raw) => {

          if (typeof raw !== 'string') return { iso: '', display: '' };

          const trimmed = raw.trim();

          if (!trimmed) return { iso: '', display: '' };

          let cleaned = trimmed

            .replace(/[/.]/g, '-')

            .replace(/[tT]/, ' ')

            .replace(/\s+/g, ' ')

            .trim();



          let match = /(\d{4})-(\d{1,2})-(\d{1,2})\s+([0-2]?\d):([0-5]?\d)$/.exec(cleaned);

          if (!match) {

            const digitsOnly = cleaned.replace(/\D/g, '');

            if (digitsOnly.length === 12) {

              match = [

                '',

                digitsOnly.slice(0, 4),

                digitsOnly.slice(4, 6),

                digitsOnly.slice(6, 8),

                digitsOnly.slice(8, 10),

                digitsOnly.slice(10, 12),

              ];

            } else {

              return { iso: '', display: cleaned };

            }

          }



          const year = clampNumber(Number(match[1]), 1970, 9999);

          const month = clampNumber(Number(match[2]), 1, 12);

          const day = clampNumber(Number(match[3]), 1, 31);

          const hours = clampNumber(Number(match[4]), 0, 23);

          const minutes = clampNumber(Number(match[5]), 0, 59);

          const iso =

            String(year).padStart(4, '0') +

            '-' +

            String(month).padStart(2, '0') +

            '-' +

            String(day).padStart(2, '0') +

            'T' +

            String(hours).padStart(2, '0') +

            ':' +

            String(minutes).padStart(2, '0');

          const display = iso.slice(0, 10) + ' ' + iso.slice(11, 16);

          return { iso, display };

        };



        const applyDateTimeTextBehavior = (input) => {

          if (!input || input.dataset.datetimeFormatterApplied === '1') return;

          input.dataset.datetimeFormatterApplied = '1';

          const enforce = () => {

            const normalized = normalizeDateTimeText(input.value);

            if (input.value.trim() && !normalized.iso) {

              input.classList.add('is-invalid');

              input.setCustomValidity('Use YYYY-MM-DD HH:MM');

            } else {

              input.classList.remove('is-invalid');

              input.setCustomValidity('');

            }

            input.value = normalized.display;

          };

          input.addEventListener('input', () => {

            input.value = input.value.replace(/[^0-9 T:-]/g, '');

          });

          input.addEventListener('blur', enforce);

          enforce();

        };



        function formatBytes(bytes) {

          if (!Number.isFinite(bytes) || bytes <= 0) {

            return '0 B';

          }

          const units = ['B', 'KB', 'MB', 'GB', 'TB'];

          let value = bytes;

          let index = 0;

          while (value >= 1024 && index < units.length - 1) {

            value /= 1024;

            index += 1;

          }

          const decimals = value < 10 && index > 0 ? 1 : 0;

          return value.toFixed(decimals) + ' ' + units[index];

        }



        function setProgress(percent, label) {

          if (uploadProgressBarEl) {

            const clamped = Math.max(0, Math.min(100, Number(percent) || 0));

            uploadProgressBarEl.style.setProperty('--progress', clamped + '%');

          }

          if (uploadProgressLabelEl && label !== undefined) {

            uploadProgressLabelEl.textContent = label;

          }

        }



        function showProgress(totalBytes) {

          if (uploadProgressEl) {

            uploadProgressEl.classList.add('is-visible');

          }

          const label = totalBytes

            ? 'Preparing upload (' + formatBytes(totalBytes) + ')'

            : 'Preparing upload...';

          setProgress(0, label);

        }



        function hideProgress() {

          if (uploadProgressEl) {

            uploadProgressEl.classList.remove('is-visible');

          }

          setProgress(0, '');

        }



        function emitDebug() {

          if (!debugState.enabled || !debugLogEl) return;

          debugLogEl.textContent = JSON.stringify(debugState.timeline, null, 2);

        }



        function recordDebug(eventName, data) {

          if (!debugState.enabled) return;

          debugState.timeline.push(

            Object.assign({ event: eventName, at: new Date().toISOString() }, data || {})

          );

          if (debugState.timeline.length > 120) {

            debugState.timeline.shift();

          }

          emitDebug();

        }



        function applyDebugState(enabled) {

          debugState.enabled = !!enabled;

          debugToggleEls.forEach((el) => {

            el.checked = debugState.enabled;

          });

          if (debugPanelEl) {

            if (debugState.enabled) {

              debugPanelEl.classList.add('is-visible');

            } else {

              debugPanelEl.classList.remove('is-visible');

            }

          }

          if (!debugState.enabled && debugLogEl) {

            debugLogEl.textContent = 'Debug output will appear here once enabled.';

          } else if (debugState.enabled) {

            emitDebug();

            requestAnimationFrame(() => fillDebugDefaults());

          }

          try {

            window.localStorage.setItem(DEBUG_KEY, debugState.enabled ? '1' : '0');

          } catch (err) {

            // ignore storage failures

          }

        }



        function fillDebugDefaults() {

          if (!debugState.enabled) return;



          const formType = formTypeSelectEl ? formTypeSelectEl.value : '';

          const isInstallation = formType === 'installation_report';

          const isServiceOrMaintenance = formType === 'service_report' || formType === 'maintenance';



          const firstOptionValue = (datalistId) => {

            if (!datalistId) return '';

            const list =

              document.getElementById(datalistId) ||

              document.querySelector('datalist#' + datalistId) ||

              document.querySelector('[data-suggest-list="' + datalistId + '"]');

            if (!list) return '';

            const opt = list.querySelector('option');

            return opt ? opt.value || '' : '';

          };



          const setIfEmpty = (selector, value) => {

            const el = formEl.querySelector(selector);

            if (el && !el.value.trim()) {

              el.value = value;

              el.dispatchEvent(new Event('input', { bubbles: true }));

              el.dispatchEvent(new Event('change', { bubbles: true }));

            }

            return el;

          };



          const setCheckbox = (name, checked = true) => {

            const el = formEl.querySelector('input[name="' + name + '"]');

            if (el && el.type === 'checkbox' && el.checked !== checked) {

              el.checked = checked;

              el.dispatchEvent(new Event('change', { bubbles: true }));

            }

            return el;

          };



          const toLocalDateTimeValue = (date) => {

            if (!(date instanceof Date)) return '';

            const tzSafe = new Date(date.getTime() - date.getTimezoneOffset() * 60000);

            return tzSafe.toISOString().slice(0, 16);

          };



          const todayIso = new Date().toISOString().slice(0, 10);

          if (formType === 'daily_report') {

            setIfEmpty('[name="daily_project_number"]', 'DR-001');

            setIfEmpty('[name="daily_report_date"]', todayIso);

            setIfEmpty('[name="submitter_name"]', 'Debug Reporter');

            setIfEmpty('[name="daily_report_text"]', 'Daily report summary (debug).');

            return;

          }

          if (isInstallation) {

            const projectSeed = 'Demo Building Project';

            const clientSeed = firstOptionValue('suggest-end-customer-name') || 'Debug Client GmbH';

            const supplierSeed =

              firstOptionValue('suggest-service-company-name') || 'Sharp / NEC Install Team';



            setIfEmpty('[name="batch_number"]', 'LSC-DBG-001');

            setIfEmpty('[name="building_project"]', projectSeed);

            setIfEmpty('[name="customer_company"]', clientSeed);

            setIfEmpty('[name="completion_date"]', todayIso);

            setIfEmpty('[name="acceptance_date"]', todayIso);

            setIfEmpty('[name="acceptance_location"]', 'Berlin');

            setIfEmpty('[name="attendee_client"]', clientSeed + ' representative');

            setIfEmpty('[name="attendee_supplier"]', supplierSeed + ' representative');



            setCheckbox('acceptance_overall', true);

            setCheckbox('acceptance_partial', false);

            setIfEmpty('[name="partial_services"]', 'Installed LED wall, cabling, and handover.');



            setCheckbox('defects_none', true);

            setCheckbox('defects_annex', false);

            setCheckbox('remaining_annex', false);

            setIfEmpty('[name="defects_deadline"]', todayIso);

            setIfEmpty('[name="remaining_deadline"]', todayIso);

            setIfEmpty('[name="supplier_objections"]', 'No objections (debug mode).');



            setCheckbox('declaration_accepted', true);

            setCheckbox('declaration_after_defects', false);

            setCheckbox('declaration_not_accepted', false);

            setCheckbox('declaration_reservations', false);



            setIfEmpty('[name="warranty_years"]', '2');

            setIfEmpty('[name="warranty_begin"]', todayIso);

            updateWarrantyEnd();



            setIfEmpty('[name="annex1_date"]', todayIso);

            setIfEmpty('[name="annex1_building_project"]', projectSeed);

            setIfEmpty('[name="annex1_defects"]', 'No defects recorded (debug).');

            setIfEmpty('[name="annex1_remaining"]', 'Only cleaning and documentation pending.');

            setIfEmpty('[name="annex1_objections"]', 'None.');

            setIfEmpty('[name="annex1_reservations"]', 'None.');



            const nowInput = toLocalDateTimeValue(new Date());

            setIfEmpty('[name="engineer_company"]', supplierSeed);

            setIfEmpty('[name="engineer_name"]', 'Debug Installer');

            setIfEmpty('[name="engineer_datetime"]', nowInput);

            setIfEmpty('[name="customer_company"]', clientSeed);

            setIfEmpty('[name="customer_name"]', clientSeed + ' contact');

            setIfEmpty('[name="customer_datetime"]', nowInput);



            return;

          }



          setIfEmpty(

            '[name="end_customer_name"]',

            firstOptionValue('suggest-end-customer-name') || 'Debug Customer GmbH',

          );

          setIfEmpty(

            '[name="site_location"]',

            firstOptionValue('suggest-site-location') || 'Berlin, Teststrasse 1',

          );

          setIfEmpty(

            '[name="led_display_model"]',

            firstOptionValue('suggest-led-display-model') || 'FA 1.5 / 1.9 / 2.5',

          );

          setIfEmpty('[name="batch_number"]', 'DBG-001');

          setIfEmpty('[name="date_of_service"]', todayIso);

          setIfEmpty(

            '[name="service_company_name"]',

            firstOptionValue('suggest-service-company-name') || 'Sharp / NEC LED Solution Center',

          );



          const firstEngineer = firstOptionValue('suggest-employee-name') || 'Debug Engineer';

          const firstCustomer = firstOptionValue('suggest-end-customer-name') || 'Debug Customer';

          setIfEmpty('#engineer-name', firstEngineer);

          setIfEmpty('#customer-name', firstCustomer);

          setIfEmpty(

            '#engineer-company',

            firstOptionValue('suggest-service-company-name') || 'Debug Service Co',

          );

          setIfEmpty(

            '#customer-company',

            firstOptionValue('suggest-end-customer-name') || 'Debug Client Co',

          );



          if (!isServiceOrMaintenance) return;



          const ensureEmployeeRow = () => {

            let rows = Array.from(document.querySelectorAll('[data-employee-row]'));

            if (!rows.length) {

              const addBtn = document.querySelector('[data-action="employee-add"]');

              if (addBtn) {

                addBtn.click();

                rows = Array.from(document.querySelectorAll('[data-employee-row]'));

              }

            }

            return rows;

          };



          const rows = ensureEmployeeRow();

          if (rows.length) {

            const row = rows[0];

            const setRowField = (field, value) => {

              const input = row.querySelector('input[data-field="' + field + '"]');

              if (input && !input.value.trim()) {

                input.value = value;

                input.dispatchEvent(new Event('input', { bubbles: true }));

                input.dispatchEvent(new Event('change', { bubbles: true }));

              }

            };

            const employeeNameSeed = firstOptionValue('suggest-employee-name') || 'Debug Engineer';

            const employeeRoleSeed = firstOptionValue('suggest-employee-role') || 'Technician';

            setRowField('name', employeeNameSeed);

            setRowField('role', employeeRoleSeed);



            const setDateTime = (field, iso) => {

              const wrap = row.querySelector('[data-datetime-field="' + field + '"]');

              if (!wrap) return;

              const dateInput = wrap.querySelector('input[data-datetime-part="date"]');

              const timeInput = wrap.querySelector('input[data-datetime-part="time"]');

              const hiddenInput = wrap.querySelector('input[data-field="' + field + '"]');

              const parts = iso.split('T');

              if (dateInput && !dateInput.value.trim()) {

                dateInput.value = parts[0] || '';

                dateInput.dispatchEvent(new Event('input', { bubbles: true }));

              }

              if (timeInput && !timeInput.value.trim()) {

                const timeVal = (parts[1] || '').slice(0, 5);

                timeInput.value = timeVal;

                timeInput.dataset.timeCommittedValue = timeVal;

                timeInput.dispatchEvent(new Event('input', { bubbles: true }));

              }

              if (hiddenInput && !hiddenInput.value.trim()) {

                hiddenInput.value = iso;

              }

            };



            const now = new Date();

            const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);

            const fmt = (d) =>

              d.getFullYear() +

              '-' +

              String(d.getMonth() + 1).padStart(2, '0') +

              '-' +

              String(d.getDate()).padStart(2, '0') +

              'T' +

              String(d.getHours()).padStart(2, '0') +

              ':' +

              String(d.getMinutes()).padStart(2, '0');

            setDateTime('arrival', fmt(now));

            setDateTime('departure', fmt(oneHourLater));

          }

        }





        function getPhotoLabel(fieldName) {

          const container = document.querySelector('[data-photo-preview="' + fieldName + '"]');

          if (!container) return fieldName;

          return container.dataset.photoLabel || fieldName;

        }



        function updateFilesSummary() {

          if (!uploadFilesSummaryEl) return;

          uploadFilesSummaryEl.innerHTML = '';

          let hasEntries = false;

          selectedFiles.forEach((files, fieldName) => {

            if (!files || !files.length) {

              return;

            }

            hasEntries = true;

            const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);

            const item = document.createElement('div');

            const label = getPhotoLabel(fieldName);

            const countText = files.length === 1 ? '1 file' : files.length + ' files';

            item.innerHTML =

              '<strong>' +

              label +

              ':</strong> ' +

              countText +

              ' (' +

              formatBytes(totalBytes) +

              ')';

            uploadFilesSummaryEl.appendChild(item);

          });

          if (!hasEntries) {

            const emptyRow = document.createElement('div');

            emptyRow.textContent = 'No photos selected yet.';

            uploadFilesSummaryEl.appendChild(emptyRow);

          }

        }



        const PHOTO_COMPRESS_MAX_EDGE = 1600;
        const PHOTO_COMPRESS_QUALITY = 0.78;
        const PHOTO_COMPRESS_MIN_BYTES = 350 * 1024;

        const loadImageFromFile = (file) =>
          new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
              URL.revokeObjectURL(objectUrl);
              resolve(img);
            };
            img.onerror = (err) => {
              URL.revokeObjectURL(objectUrl);
              reject(err || new Error('Image load failed.'));
            };
            img.src = objectUrl;
          });

        const normalizeCompressedName = (name, mimeType) => {
          const base = String(name || 'upload').replace(/.[^/.]+$/, '');
          if (mimeType === 'image/jpeg') {
            return base + '.jpg';
          }
          return base;
        };

        const compressImageFile = async (file) => {
          if (!(file instanceof File)) return file;
          if (!file.type || !file.type.startsWith('image/')) return file;
          if (file.size && file.size < PHOTO_COMPRESS_MIN_BYTES) return file;
          let img;
          try {
            img = await loadImageFromFile(file);
          } catch (err) {
            return file;
          }
          const width = img.naturalWidth || img.width || 0;
          const height = img.naturalHeight || img.height || 0;
          if (!width || !height) return file;
          const maxEdge = Math.max(width, height);
          const scale = maxEdge > PHOTO_COMPRESS_MAX_EDGE ? PHOTO_COMPRESS_MAX_EDGE / maxEdge : 1;
          const targetWidth = Math.max(1, Math.round(width * scale));
          const targetHeight = Math.max(1, Math.round(height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) return file;
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, targetWidth, targetHeight);
          ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
          const blob = await new Promise((resolve) => {
            canvas.toBlob((value) => resolve(value), 'image/jpeg', PHOTO_COMPRESS_QUALITY);
          });
          if (!blob || !blob.size || blob.size >= file.size) return file;
          return new File([blob], normalizeCompressedName(file.name, blob.type), {
            type: blob.type,
            lastModified: file.lastModified,
          });
        };

        const compressFormImages = async (rawFormData) => {
          let originalBytes = 0;
          let compressedBytes = 0;
          let compressedCount = 0;
          let totalFiles = 0;
          const compressedFormData = new FormData();

          for (const [key, value] of rawFormData.entries()) {
            if (value instanceof File) {
              totalFiles += 1;
              const size = value.size || 0;
              originalBytes += size;
              let nextFile = value;
              try {
                nextFile = await compressImageFile(value);
              } catch (err) {
                nextFile = value;
              }
              if (nextFile !== value) {
                compressedCount += 1;
                compressedBytes += nextFile.size || 0;
              } else {
                compressedBytes += size;
              }
              compressedFormData.append(key, nextFile, nextFile.name);
            } else {
              compressedFormData.append(key, value);
            }
          }

          if (!totalFiles) {
            return {
              formData: rawFormData,
              originalBytes: 0,
              compressedBytes: 0,
              compressedCount: 0,
              totalFiles: 0,
            };
          }

          return {
            formData: compressedFormData,
            originalBytes,
            compressedBytes,
            compressedCount,
            totalFiles,
          };
        };


        function revokePreviewUrls(fieldName) {

          const urls = previewUrls.get(fieldName);

          if (urls) {

            urls.forEach((url) => URL.revokeObjectURL(url));

          }

          previewUrls.delete(fieldName);

        }



        function renderPreview(fieldName, files, mode) {

          const container = document.querySelector('[data-photo-preview="' + fieldName + '"]');

          if (!container) return;

          revokePreviewUrls(fieldName);

          container.innerHTML = '';

          if (!files || !files.length) {

            container.dataset.state = 'empty';

            const span = document.createElement('span');

            span.textContent = mode === 'multi' ? 'No files selected yet.' : 'No file selected yet.';

            container.appendChild(span);

            return;

          }

          container.dataset.state = 'filled';

          const urls = [];

          if (mode === 'multi') {

            const list = document.createElement('div');

            list.className = 'photo-preview-list';

            files.forEach((file) => {

              const item = document.createElement('div');

              item.className = 'photo-preview-item';

              const img = document.createElement('img');

              const url = URL.createObjectURL(file);

              urls.push(url);

              img.src = url;

              img.alt = file.name;

              img.onerror = () => {

                URL.revokeObjectURL(url);

                const reader = new FileReader();

                reader.onload = () => {

                  img.src = reader.result;

                };

                reader.readAsDataURL(file);

              };

              const caption = document.createElement('span');

              caption.textContent = file.name + ' (' + formatBytes(file.size || 0) + ')';

              item.appendChild(img);

              item.appendChild(caption);

              list.appendChild(item);

            });

            container.appendChild(list);

          } else {

            const file = files[0];

            const item = document.createElement('div');

            item.className = 'photo-preview-item';

            const img = document.createElement('img');

            const url = URL.createObjectURL(file);

            urls.push(url);

            img.src = url;

            img.alt = file.name;

            img.onerror = () => {

              URL.revokeObjectURL(url);

              const reader = new FileReader();

              reader.onload = () => {

                img.src = reader.result;

              };

              reader.readAsDataURL(file);

            };

            const caption = document.createElement('span');

            caption.textContent = file.name + ' (' + formatBytes(file.size || 0) + ')';

            item.appendChild(img);

            item.appendChild(caption);

            container.appendChild(item);

          }

          previewUrls.set(fieldName, urls);

        }



        function handleFileSelection(fieldName, fileList, mode) {

          const files = fileList ? Array.from(fileList) : [];

          selectedFiles.set(fieldName, files);

          renderPreview(fieldName, files, mode);

          updateFilesSummary();

          recordDebug('files-updated', {

            field: fieldName,

            count: files.length,

            totalBytes: files.reduce((sum, file) => sum + (file.size || 0), 0),

            names: files.map((file) => file.name),

          });

        }



        function setupAutoResizeTextareas() {

          const textareas = document.querySelectorAll('textarea[data-auto-resize]');

          if (!textareas.length) return;

          const resize = (textarea) => {

            textarea.style.height = 'auto';

            const newHeight = Math.max(textarea.scrollHeight, 44);

            textarea.style.height = newHeight + 'px';

          };

          textareas.forEach((textarea) => {

            textarea.style.overflow = 'hidden';

            resize(textarea);

            textarea.addEventListener('input', () => resize(textarea));

            textarea.addEventListener('change', () => resize(textarea));

          });

        }



        function setupDateTimeTextInputs() {

          document.querySelectorAll(DATETIME_TEXT_SELECTOR).forEach((input) => {

            applyDateTimeTextBehavior(input);

          });

        }



        function setupPartsTable() {

          const hiddenClass = 'is-hidden-row';

          const sections = Array.from(document.querySelectorAll('[data-parts-section]'));

          if (!sections.length) return;



          sections.forEach((section) => {

            const table = section.querySelector('[data-parts-table]');

            if (!table) return;

            const rows = Array.from(table.querySelectorAll('.parts-row'));

            const addButton = section.querySelector('[data-action="parts-add-row"]');

            const removeButton = section.querySelector('[data-action="parts-remove-row"]');



            const enableRow = (row) => {

              row.classList.remove(hiddenClass);

              row.querySelectorAll('input, textarea').forEach((input) => {

                input.disabled = false;

              });

            };



            const disableRow = (row, clear = false) => {

              row.classList.add(hiddenClass);

              row.querySelectorAll('input, textarea').forEach((input) => {

                if (clear) input.value = '';

                input.disabled = true;

              });

            };



            const refresh = () => {

              const visibleRows = rows.filter((row) => !row.classList.contains(hiddenClass));

              if (addButton) {

                addButton.disabled = visibleRows.length >= rows.length;

              }

              if (removeButton) {

                removeButton.disabled = visibleRows.length <= 1;

              }

            };



            rows.forEach((row, index) => {

              if (index === 0) {

                enableRow(row);

              } else if (

                Array.from(row.querySelectorAll('input, textarea')).some((input) => input.value.trim().length)

              ) {

                enableRow(row);

              } else {

                disableRow(row, true);

              }

            });



            refresh();



            if (addButton) {

              addButton.addEventListener('click', (event) => {

                event.preventDefault();

                const nextHidden = rows.find((row) => row.classList.contains(hiddenClass));

                if (!nextHidden) return;

                enableRow(nextHidden);

                refresh();

              });

            }



            if (removeButton) {

              removeButton.addEventListener('click', (event) => {

                event.preventDefault();

                const visibleRows = rows.filter((row) => !row.classList.contains(hiddenClass));

                if (visibleRows.length <= 1) return;

                const lastVisible = visibleRows[visibleRows.length - 1];

                disableRow(lastVisible, true);

                refresh();

              });

            }

          });

        }



        function setupPartsOcr() {

          const anyTrigger = document.querySelector('[data-parts-ocr]');

          if (!anyTrigger) return;

          const friendlyHint = 'Upload a clear photo of the part label to auto-fill serial/model fields (OCR).';



          const ensureHint = () => {

            const section = findActivePartsSection();

            const statusEl = section ? section.querySelector('[data-parts-ocr-status]') : null;

            if (statusEl && !statusEl.textContent.trim()) {

              statusEl.textContent = friendlyHint;

              statusEl.style.color = '#475569';

            }

          };

          ensureHint();



          const processFile = (file, inputEl) => {

            if (!file) {

              setPartsOcrStatus('No photo selected.', true);

              return;

            }

            recordDebug('parts-ocr-start', { name: file.name, size: file.size || 0 });

            Promise.resolve(handlePartsOcrFile(file))

              .then(() => {

                recordDebug('parts-ocr-complete', { name: file.name });

              })

              .catch((err) => {

                setPartsOcrStatus(err && err.message ? err.message : 'OCR failed.', true);

                recordDebug('parts-ocr-error', { error: String(err && err.message ? err.message : err) });

              });

            if (inputEl) {

              inputEl.value = '';

            }

          };



          document.addEventListener('click', (event) => {

            const button = event.target.closest('[data-parts-ocr]');

            if (!button) return;

            event.preventDefault();

            const section = button.closest('[data-parts-section]') || findActivePartsSection();

            const inputEl = section ? section.querySelector('[data-parts-ocr-input]') : null;

            if (inputEl) {

              inputEl.click();

            } else {

              setPartsOcrStatus('Photo input is unavailable on this device.', true);

            }

          });



          document.addEventListener('change', (event) => {

            const input = event.target && event.target.closest ? event.target.closest('[data-parts-ocr-input]') : null;

            if (!input) return;

            const section = input.closest('[data-parts-section]');

            if (section && (section.hidden || section.style.display === 'none')) return;

            const files = event.target && event.target.files ? Array.from(event.target.files) : [];

            processFile(files[0], input);

          });

        }



        function setupEmployees() {

          const section = document.querySelector('[data-employees-section]');

          if (!section) return;

          ensureTimePresetList();



          const listEl = section.querySelector('[data-employee-list]');

          const template = section.querySelector('#employee-row-template');

          const addButton = section.querySelector('[data-action="employee-add"]');
          const breaksToggleEl = section.querySelector('[data-breaks-toggle]');

          const summaryEl = section.querySelector('[data-employee-summary]');

          const summaryTotalEl = summaryEl ? summaryEl.querySelector('[data-employee-total]') : null;

          const summaryCountEl = summaryEl ? summaryEl.querySelector('[data-employee-count]') : null;



          if (!listEl || !template) return;



          const engineerNameInput = document.querySelector('#engineer-name');

          const engineerDatetimeInput = document.querySelector('#engineer-datetime');

          const customerDatetimeInput = document.querySelector('#customer-datetime');



          const maxRows = Math.max(1, Number(section.dataset.employeeMax || '0') || 20);

          const DEFAULT_SHIFT_MINUTES = 8 * 60;

          const rowStates = new Map();

          let groupCounter = 1;

          const createGroupId = () => 'emp-' + groupCounter++;

          let suppressSummaryLog = false;



          const signoffSync = {

            name: { manual: false, syncedValue: '' },

            datetime: { manual: false, syncedValue: '' },

          };
          const breaksEnabled = () => Boolean(breaksToggleEl && breaksToggleEl.checked);



          const pad = (value) => (value < 10 ? '0' + value : String(value));



          const formatIsoFromDate = (date) => {

            if (!(date instanceof Date) || Number.isNaN(date.getTime())) {

              return '';

            }

            return (

              date.getFullYear() +

              '-' +

              pad(date.getMonth() + 1) +

              '-' +

              pad(date.getDate()) +

              'T' +

              pad(date.getHours()) +

              ':' +

              pad(date.getMinutes())

            );

          };



          const parseLocalDateTime = (value) => {

            if (typeof value !== 'string') return null;

            const trimmed = value.trim();

            if (!trimmed) return null;

            const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(trimmed);

            if (!match) return null;

            const date = new Date(

              Number(match[1]),

              Number(match[2]) - 1,

              Number(match[3]),

              Number(match[4]),

              Number(match[5]),

              0,

              0

            );

            if (Number.isNaN(date.getTime())) return null;

            return date;

          };



          const nowLocalIso = () => formatIsoFromDate(new Date());

          const formSessionStartIso = nowLocalIso();



          const addMinutesToIso = (iso, minutes) => {

            const base = parseLocalDateTime(iso);

            if (!base) return '';

            const delta = Number(minutes || 0);

            if (Number.isNaN(delta)) return iso;

            base.setMinutes(base.getMinutes() + delta);

            return formatIsoFromDate(base);

          };

          const addDaysToIso = (iso, days) => {

            const base = parseLocalDateTime(iso);

            if (!base) return '';

            const delta = Number(days || 0);

            if (Number.isNaN(delta)) return iso;

            base.setDate(base.getDate() + delta);

            return formatIsoFromDate(base);

          };



          const formatEmployeeDuration = (minutes) => {

            if (!Number.isFinite(minutes) || minutes <= 0) return '0m';

            const rounded = Math.round(minutes);

            const hours = Math.floor(rounded / 60);

            const mins = Math.max(0, rounded - hours * 60);

            const parts = [];

            if (hours) parts.push(hours + 'h');

            if (mins) parts.push(mins + 'm');

            return parts.length ? parts.join(' ') : '0m';

          };



          const determineBreakRequirement = (minutes) => {

            if (!Number.isFinite(minutes) || minutes <= 0) {

              return { code: 'UNKNOWN', minutes: 0, label: 'Pending (set arrival and departure)' };

            }

            if (minutes <= 6 * 60) {

              return { code: 'NONE', minutes: 0, label: 'No mandatory break (<=6h)' };

            }

            if (minutes <= 9 * 60) {

              return { code: 'MIN30', minutes: 30, label: '>=30m (6-9h, 2x15m allowed)' };

            }

            return { code: 'MIN45', minutes: 45, label: '>=45m (>9h)' };

          };



          const formatBreakStatsSummary = (stats) => {

            if (!stats) return '';

            const descriptors = [

              { key: 'MIN45', label: '>=45m (>9h)' },

              { key: 'MIN30', label: '>=30m (6-9h, 2x15m)' },

              { key: 'NONE', label: 'no mandatory break (<=6h)' },

            ];

            const parts = [];

            descriptors.forEach(({ key, label }) => {

              const count = Number(stats[key] || 0);

              if (count > 0) {

                parts.push(count + ' x ' + label);

              }

            });

            const pending = Number(stats.UNKNOWN || 0);

            if (pending > 0 && parts.length) {

              parts.push(pending + ' x pending');

            }

            return parts.join(', ');

          };



          const rowElements = () => Array.from(listEl.querySelectorAll('[data-employee-row]'));

          const isPrimaryRow = (row) => row && row === rowElements()[0];



          const ensureSignoffDefaults = () => {

            const defaultIso = nowLocalIso();

            if (engineerDatetimeInput && !engineerDatetimeInput.value) {

              engineerDatetimeInput.value = defaultIso;

              signoffSync.datetime.syncedValue = defaultIso;

            }

            if (customerDatetimeInput && !customerDatetimeInput.value) {

              customerDatetimeInput.value = defaultIso;

            }

          };



          ensureSignoffDefaults();



          if (engineerNameInput) {

            engineerNameInput.addEventListener('input', () => {

              signoffSync.name.manual = true;

            });

          }

          if (engineerDatetimeInput) {

            engineerDatetimeInput.addEventListener('input', () => {

              signoffSync.datetime.manual = true;

            });

          }



          function setDateTimeValue(row, field, iso) {

            const wrapper = row.querySelector('[data-datetime-field="' + field + '"]');

            if (!wrapper) return;

            const hidden = wrapper.querySelector('input[data-field="' + field + '"]');

            const dateInput = wrapper.querySelector('input[data-datetime-part="date"]');

            const timeInput = wrapper.querySelector('input[data-datetime-part="time"]');

            const safeIso = iso || '';

            if (hidden) hidden.value = safeIso;

            const parts = safeIso.split('T');

            if (dateInput) {

              dateInput.value = parts[0] || '';

            }

            if (timeInput) {

              const nextValue = parts[1] ? parts[1].slice(0, 5) : '';

              timeInput.value = nextValue;

              if (timeInput.dataset) {

                timeInput.dataset.timeCommittedValue = (nextValue || '').trim();

              }

            }

          }



          function getDateTimePair(row, field) {

            const wrapper = row.querySelector('[data-datetime-field="' + field + '"]');

            if (!wrapper) return null;

            return {

              dateInput: wrapper.querySelector('input[data-datetime-part="date"]'),

              timeInput: wrapper.querySelector('input[data-datetime-part="time"]'),

              hiddenInput: wrapper.querySelector('input[data-field="' + field + '"]'),

            };

          }



          const syncGroupInput = (row, groupId) => {

            if (!row) return;

            if (groupId) {

              row.dataset.employeeGroup = groupId;

            }

            const input = row.querySelector('input[data-field="group"]');

            if (input) {

              input.value = row.dataset.employeeGroup || groupId || '';

            }

          };


          function combineDateTimeValue(row, field) {

            const pair = getDateTimePair(row, field);

            if (!pair) return '';

            const dateValue = pair.dateInput ? pair.dateInput.value.trim() : '';

            const timeValue = pair.timeInput ? pair.timeInput.value.trim() : '';

            const hasValidTime = TIME_VALUE_REGEX.test(timeValue);

            const iso = dateValue && hasValidTime ? dateValue + 'T' + timeValue : '';

            if (pair.hiddenInput) {

              if (iso) {

                pair.hiddenInput.value = iso;

              } else if (!dateValue && !timeValue) {

                pair.hiddenInput.value = '';

              } else if (!hasValidTime) {

                pair.hiddenInput.value = '';

              }

            }

            return iso;

          }



          function updateRowDurationDisplay(row, state) {

            const target = row.querySelector('[data-employee-duration]');

            if (!target) return;

            target.textContent =

              'Working time: ' +

              formatEmployeeDuration(state.durationMinutes) +

              ' | Break: ' +

              state.breakLabel;

          }



          const updateControlState = () => {

            if (addButton) {

              addButton.disabled = rowElements().length >= maxRows;

            }

          };



          function renumberRows() {

            rowElements().forEach((row, index) => {

              row.dataset.index = String(index + 1);

              const title = row.querySelector('[data-employee-title]');

              if (title) {

                title.textContent = 'Employee #' + (index + 1);

              }

              const setName = (selector, field) => {

                const input = row.querySelector(selector);

                if (input) {

                  input.name = 'employees[' + index + '][' + field + ']';

                }

              };

              setName('input[data-field="name"]', 'name');

              setName('input[data-field="role"]', 'role');

              setName('input[data-field="arrival"]', 'arrival');

              setName('input[data-field="departure"]', 'departure');

              setName('input[data-field="group"]', 'group');

              syncGroupInput(row, row.dataset.employeeGroup);

            });

            updateControlState();

          }



          const normalizeEmployeeToken = (value) => {

            return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();

          };

          const buildEmployeeKey = (state, row) => {

            const groupId =

              state && state.groupId

                ? state.groupId

                : row && row.dataset

                  ? row.dataset.employeeGroup

                  : '';

            if (groupId) {

              return 'group:' + groupId;

            }

            const nameKey = normalizeEmployeeToken(state ? state.name : '');


            const roleKey = normalizeEmployeeToken(state ? state.role : '');

            if (nameKey || roleKey) {

              return 'nr:' + nameKey + '|' + roleKey;

            }

            const rowIndex = row && row.dataset ? row.dataset.index : '';


            return 'row:' + (rowIndex || '');

          };


          function updateSummary(reason) {
          
            const summary = {
          
              count: 0,
          
              uniqueCount: 0,
          
              totalMinutes: 0,
          
              totalBreakMinutes: 0,
          
              breakStats: { NONE: 0, MIN30: 0, MIN45: 0, UNKNOWN: 0 },
          
            };
          
            const breaksActive = breaksEnabled();
          
            const uniqueKeys = new Set();
          
            rowElements().forEach((row) => {
          
              const state = rowStates.get(row);
          
              if (!state || !state.hasData) return;
          
              summary.count += 1;
          
              const key = buildEmployeeKey(state, row);
          
              if (key) {
          
                uniqueKeys.add(key);
          
              }
          
              summary.totalMinutes += state.durationMinutes;
          
              if (breaksActive) {
          
                summary.totalBreakMinutes += state.breakRequiredMinutes;
          
                if (summary.breakStats[state.breakCode] === undefined) {
          
                  summary.breakStats.UNKNOWN += 1;
          
                } else {
          
                  summary.breakStats[state.breakCode] += 1;
          
                }
          
              }
          
            });
          
            summary.uniqueCount = uniqueKeys.size;
          
            if (summaryTotalEl) {
          
              if (summary.count === 0) {
          
                summaryTotalEl.textContent = 'Working time: 0m | Required breaks: pending';
          
              } else {
          
                summaryTotalEl.textContent =
          
                  'Working time: ' +
          
                  formatEmployeeDuration(summary.totalMinutes) +
          
                  ' | Required breaks: ' +
          
                  (breaksActive ? formatEmployeeDuration(summary.totalBreakMinutes) : 'disabled');
          
              }
          
            }
          
            if (summaryCountEl) {
          
              if (summary.count === 0) {
          
                summaryCountEl.textContent = 'No employees added yet.';
          
              } else {
          
                const employeeCount = summary.uniqueCount || summary.count;
          
                const base =
          
                  employeeCount === 1
          
                    ? '1 employee recorded.'
          
                    : employeeCount + ' employees recorded.';
          
                const breakSummary = breaksActive
          
                  ? formatBreakStatsSummary(summary.breakStats)
          
                  : '';
          
                summaryCountEl.textContent = breakSummary ? base + ' ' + breakSummary : base;
          
              }
          
            }
          
            if (!suppressSummaryLog) {
          
              recordDebug('employee-summary', {
          
                reason: reason || 'update',
          
                totalMinutes: summary.totalMinutes,
          
                totalBreakMinutes: summary.totalBreakMinutes,
          
                breakStats: summary.breakStats,
          
                count: summary.count,
          
                uniqueCount: summary.uniqueCount,
          
                breaksEnabled: breaksActive,
          
              });
          
            }
          
            return summary;
          
          }

          }



          function syncEngineerSignoff(primaryState) {

            if (!primaryState) return;

            if (engineerNameInput && !signoffSync.name.manual && primaryState.name) {

              engineerNameInput.value = primaryState.name;

              signoffSync.name.syncedValue = primaryState.name;

            }

            if (engineerDatetimeInput && !signoffSync.datetime.manual) {

              const candidate = primaryState.departure || primaryState.arrival || nowLocalIso();

              if (candidate) {

                engineerDatetimeInput.value = candidate;

                signoffSync.datetime.syncedValue = candidate;

              }

            }

          }



          function updateRowState(row, reason, options = {}) {

            const previous = rowStates.get(row) || {};

            const indexLabel = row.dataset.index || '';

            const nameInput = row.querySelector('input[data-field="name"]');

            const roleInput = row.querySelector('input[data-field="role"]');



            const name = nameInput ? nameInput.value.trim() : '';

            const role = roleInput ? roleInput.value.trim() : '';

            let arrivalIso = combineDateTimeValue(row, 'arrival');

            let departureIso = combineDateTimeValue(row, 'departure');



            const arrivalDate = parseLocalDateTime(arrivalIso);

            let departureDate = parseLocalDateTime(departureIso);

            let durationMinutes = 0;



            const departurePair = getDateTimePair(row, 'departure');

            const departureTimeInput = departurePair ? departurePair.timeInput : null;

            const departureActive =

              departureTimeInput && document.activeElement === departureTimeInput;

            const departureRaw =

              departureTimeInput && typeof departureTimeInput.value === 'string'

                ? departureTimeInput.value.trim()

                : '';

            const departureValueValid = TIME_VALUE_REGEX.test(departureRaw);



            if (arrivalDate && !departureDate) {

              if (!(departureActive && !departureValueValid)) {

                departureDate = new Date(arrivalDate.getTime() + 60 * 60000);

                departureIso = formatIsoFromDate(departureDate);

                setDateTimeValue(row, 'departure', departureIso);

              }

            }



            if (arrivalDate && departureDate) {

              durationMinutes = Math.round((departureDate.getTime() - arrivalDate.getTime()) / 60000);

              if (durationMinutes <= 0) {

                departureDate = new Date(arrivalDate.getTime() + 15 * 60000);

                departureIso = formatIsoFromDate(departureDate);

                setDateTimeValue(row, 'departure', departureIso);

                durationMinutes = 15;

              }

            }



            const breaksActive = breaksEnabled();

            const breakInfo = breaksActive
              ? determineBreakRequirement(durationMinutes)
              : { code: 'DISABLED', minutes: 0, label: 'Breaks disabled' };

            const hasData = Boolean(name || role || arrivalIso || departureIso);



            let syncedWithPrimary = previous.syncedWithPrimary || false;

            if (options.markSynced === true) {

              syncedWithPrimary = true;

            } else if (reason !== 'primary-sync' && !options.preserveSyncFlag) {

              syncedWithPrimary = false;

            }



            const state = {

              hasData,

              name,

              role,

              groupId: row.dataset.employeeGroup || '',

              arrival: arrivalIso,

              departure: departureIso,

              durationMinutes,

              breakCode: breakInfo.code,

              breakRequiredMinutes: breakInfo.minutes,

              breakLabel: breakInfo.label,

              syncedWithPrimary,

            };



            updateRowDurationDisplay(row, state);

            rowStates.set(row, state);



            if (!suppressSummaryLog && options.logDebug !== false) {

              recordDebug('employee-updated', {

                index: indexLabel,

                reason: reason || 'change',

                hasData,

                durationMinutes,

                breakCode: breakInfo.code,

                syncedWithPrimary,

              });

            }



            if (isPrimaryRow(row)) {

              if (!options.skipPropagation) {

                propagatePrimarySchedule();

              }

              syncEngineerSignoff(state);

            }



            return state;

          }



          function propagatePrimarySchedule() {

            const rows = rowElements();

            if (!rows.length) return;

            const primaryRow = rows[0];

            const primaryState = rowStates.get(primaryRow);

            if (!primaryState || !primaryState.arrival) return;



            let summaryPending = false;

            rows.slice(1).forEach((row) => {

              const state = rowStates.get(row);

              if (!state || !state.hasData || state.syncedWithPrimary) {

                setDateTimeValue(row, 'arrival', primaryState.arrival);

                setDateTimeValue(row, 'departure', primaryState.departure || '');

                updateRowState(row, 'primary-sync', {

                  markSynced: true,

                  skipPropagation: true,

                  logDebug: false,

                  preserveSyncFlag: true,

                });

                summaryPending = true;

              }

            });



            if (summaryPending) {

              updateSummary('primary-sync');

            }

          }



          function attachListeners(row) {

            row

              .querySelectorAll('input[data-field]:not([type="hidden"])')

              .forEach((input) => {

                input.addEventListener('input', () => {

                  updateRowState(row, 'input');

                  updateSummary('input');

                });

                input.addEventListener('change', () => {

                  updateRowState(row, 'change');

                  updateSummary('change');

                });

              });



            ['arrival', 'departure'].forEach((field) => {

              const pair = getDateTimePair(row, field);

              if (!pair) return;

              [pair.dateInput, pair.timeInput].forEach((input) => {

                if (!input) return;

                input.addEventListener('input', () => {

                  updateRowState(row, 'datetime');

                  updateSummary('datetime');

                });

                input.addEventListener('change', () => {

                  updateRowState(row, 'datetime');

                  updateSummary('datetime');

                });

              });

            });


            const addDayBtn = row.querySelector('[data-action="employee-add-day"]');

            if (addDayBtn) {

              addDayBtn.addEventListener('click', (event) => {

                event.preventDefault();

                if (!row.dataset.employeeGroup) {

                  row.dataset.employeeGroup = createGroupId();

                }

                const groupId = row.dataset.employeeGroup;

                syncGroupInput(row, groupId);

                const currentState =

                  rowStates.get(row) ||

                  updateRowState(row, 'add-day', { preserveSyncFlag: true, logDebug: false });

                const name = currentState && currentState.name ? currentState.name : '';

                const role = currentState && currentState.role ? currentState.role : '';

                const baseArrival = (currentState && currentState.arrival) || formSessionStartIso;

                const baseDeparture =

                  (currentState && currentState.departure) ||

                  (baseArrival ? addMinutesToIso(baseArrival, DEFAULT_SHIFT_MINUTES) : '');

                const nextArrival = addDaysToIso(baseArrival, 1) || baseArrival;

                const nextDeparture =

                  baseDeparture ? addDaysToIso(baseDeparture, 1) || baseDeparture : '';

                const clonedRow = addRow(

                  { name, role, arrival: nextArrival, departure: nextDeparture },

                  { summaryTrigger: 'add-day', insertAfter: row, markSynced: false, groupId },

                );

                if (clonedRow) {

                  recordDebug('employee-add-day', {

                    index: clonedRow.dataset.index,

                    sourceIndex: row.dataset.index,

                    arrival: nextArrival,

                    departure: nextDeparture,

                  });

                }

              });

            }

            const removeBtn = row.querySelector('[data-action="employee-remove"]');

            if (removeBtn) {

              removeBtn.addEventListener('click', (event) => {

                event.preventDefault();

                recordDebug('employee-removed', { index: row.dataset.index });

                rowStates.delete(row);

                row.remove();

                renumberRows();

                updateSummary('remove');

                propagatePrimarySchedule();

                const primaryRow = rowElements()[0];

                if (primaryRow) {

                  const primaryState = rowStates.get(primaryRow);

                  if (primaryState) {

                    primaryState.syncedWithPrimary = false;

                    rowStates.set(primaryRow, primaryState);

                    syncEngineerSignoff(primaryState);

                  }

                }

              });

            }

          }



          function bindTimeShortcuts(row) {

            if (!row) return;

            row.querySelectorAll(TIME_INPUT_SELECTOR).forEach((input) => applyTimeInputBehavior(input));

            if (row.dataset.timeShortcutsBound === '1') return;

            row.dataset.timeShortcutsBound = '1';

            row.addEventListener('click', (event) => {

              const trigger = event.target.closest('[data-action="time-now"], [data-action="time-adjust"]');

              if (!trigger) return;

              event.preventDefault();

              const wrapper = trigger.closest('[data-datetime-field]');

              if (!wrapper) return;

              const field = wrapper.dataset.datetimeField;

              if (!field) return;

              const pair = getDateTimePair(row, field);

              if (!pair || !pair.timeInput) return;

              if (trigger.dataset.action === 'time-now') {

                const nowIso = nowLocalIso();

                const dateValue = nowIso.slice(0, 10);

                const timeValue = normalizeTimeInputValue(nowIso.slice(11, 16));

                const iso = dateValue && timeValue ? dateValue + 'T' + timeValue : '';

                if (iso) {

                  setDateTimeValue(row, field, iso);

                } else {

                  if (pair.dateInput && !pair.dateInput.value) {

                    pair.dateInput.value = dateValue;

                  }

                  pair.timeInput.value = timeValue;

                  if (pair.timeInput.dataset) {

                    pair.timeInput.dataset.timeCommittedValue = (timeValue || '').trim();

                  }

                }

                const combinedIso = combineDateTimeValue(row, field) || iso;

                updateRowState(row, 'time-now');

                updateSummary('time-now');

                recordDebug('employee-time-now', {

                  index: row.dataset.index,

                  field,

                  value: combinedIso,

                });

                return;

              }

              if (trigger.dataset.action === 'time-adjust') {

                const step = Number(trigger.dataset.step || 0);

                if (!step) return;

                let iso = combineDateTimeValue(row, field);

                if (!iso) {

                  const datePart =

                    (pair.dateInput && pair.dateInput.value && pair.dateInput.value.trim()) ||

                    nowLocalIso().slice(0, 10);

                  const timePart =

                    normalizeTimeInputValue(pair.timeInput.value) || nowLocalIso().slice(11, 16);

                  iso = datePart + 'T' + timePart;

                }

                if (!iso) return;

                const adjusted = addMinutesToIso(iso, step);

                if (adjusted) {

                  setDateTimeValue(row, field, adjusted);

                  updateRowState(row, 'time-adjust');

                  updateSummary('time-adjust');

                  recordDebug('employee-time-adjust', {

                    index: row.dataset.index,

                    field,

                    step,

                    value: adjusted,

                  });

                }

              }

            });

          }



          function addRow(data = {}, options = {}) {

            const existing = rowElements().length;

            if (existing >= maxRows) {

              if (!options.silent) {

                recordDebug('employee-add-blocked', { reason: 'max-reached', max: maxRows });

              }

              return null;

            }



            const fragment = template.content.cloneNode(true);

            const row = fragment.querySelector('[data-employee-row]');

            const insertAfter = options.insertAfter;

            if (insertAfter && insertAfter.parentNode === listEl) {

              const nextSibling = insertAfter.nextSibling;

              if (nextSibling) {

                listEl.insertBefore(fragment, nextSibling);

              } else {

                listEl.appendChild(fragment);

              }

            } else {

              listEl.appendChild(fragment);

            }

            const resolvedGroupId = options.groupId || createGroupId();

            syncGroupInput(row, resolvedGroupId);

            renumberRows();

            // ensure suggestion handlers are attached for newly added inputs

            setupAutoSuggestions();



            const isPrimary = isPrimaryRow(row);

            const primaryState = rowStates.get(rowElements()[0]) || null;



            const nameInput = row.querySelector('input[data-field="name"]');

            if (nameInput) {

              nameInput.value = data.name ? String(data.name) : '';

            }

            const roleInput = row.querySelector('input[data-field="role"]');

            if (roleInput) {

              roleInput.value = data.role ? String(data.role) : '';

            }



            const arrivalValue =

              (data.arrival ? String(data.arrival) : '') ||

              options.prefillArrival ||

              (isPrimary ? '' : primaryState?.arrival) ||

              '';



            const departureValue =

              (data.departure ? String(data.departure) : '') ||

              options.prefillDeparture ||

              (isPrimary ? '' : primaryState?.departure) ||

              (arrivalValue ? addMinutesToIso(arrivalValue, DEFAULT_SHIFT_MINUTES) : '');



            setDateTimeValue(row, 'arrival', arrivalValue);

            setDateTimeValue(row, 'departure', departureValue);



            bindTimeShortcuts(row);



            attachListeners(row);



            const markSynced =

              options.markSynced !== undefined ? options.markSynced : !isPrimary;

            const skipPropagation =

              options.skipPropagation !== undefined

                ? options.skipPropagation

                : !isPrimary && Boolean(primaryState);


            const state = updateRowState(

              row,

              options.summaryTrigger || (isPrimary ? 'init' : 'seed'),

              {

                markSynced,

                skipPropagation,

                logDebug: !options.silent,

              },

            );



            const summaryReason =

              options.summaryTrigger ||

              (state.hasData ? (isPrimary ? 'init' : 'seed') : 'refresh');

            updateSummary(summaryReason);



            if (!options.silent) {

              recordDebug('employee-added', {

                index: row.dataset.index,

                seeded: Boolean(options.summaryTrigger === 'seed'),

                syncedWithPrimary: markSynced,

              });

              const focusTarget = row.querySelector('input[data-field="name"]');

              if (focusTarget) {

                focusTarget.focus();

              }

            }



            return row;

          }



          let seedEmployees = [];

          if (section.dataset.employeesSeed) {

            try {

              const parsed = JSON.parse(section.dataset.employeesSeed);

              if (Array.isArray(parsed)) {

                seedEmployees = parsed.slice(0, maxRows);

              }

            } catch (err) {

              recordDebug('employee-seed-error', { message: err.message });

            }

          }



          suppressSummaryLog = true;

          if (seedEmployees.length) {

            seedEmployees.forEach((employee) => {

              addRow(

                {

                  name: employee.name,

                  role: employee.role,

                  arrival: employee.arrival,

                  departure: employee.departure,

                },

                { silent: true, summaryTrigger: 'seed' },

              );

            });

          } else {

            addRow(

              {},

              {

                silent: true,

                summaryTrigger: 'init',

              },

            );

          }

          suppressSummaryLog = false;

          updateSummary('init');

          propagatePrimarySchedule();

          const primaryRow = rowElements()[0];

          if (primaryRow) {

            const primaryState = rowStates.get(primaryRow);

            if (primaryState) {

              primaryState.syncedWithPrimary = false;

              rowStates.set(primaryRow, primaryState);

              syncEngineerSignoff(primaryState);

            }

          }



          if (addButton) {

            addButton.addEventListener('click', (event) => {

              event.preventDefault();

              const rows = rowElements();

              const primaryRow = rows[0] || null;

              const primaryState = primaryRow ? rowStates.get(primaryRow) : null;

              const primaryGroupId =
                primaryRow && primaryRow.dataset ? primaryRow.dataset.employeeGroup : '';

              const groupRows = primaryGroupId
                ? rows.filter((row) => row.dataset.employeeGroup === primaryGroupId)
                : primaryRow
                ? [primaryRow]
                : [];

              if (groupRows.length > 1) {

                const newGroupId = createGroupId();

                let insertAfter = rows[rows.length - 1] || null;

                let firstNewRow = null;

                groupRows.forEach((sourceRow, index) => {

                  const sourceState = rowStates.get(sourceRow) || {};

                  const baseArrival =
                    sourceState.arrival || (primaryState && primaryState.arrival) || formSessionStartIso;

                  const baseDeparture =
                    sourceState.departure ||
                    (primaryState && primaryState.departure) ||
                    (baseArrival ? addMinutesToIso(baseArrival, DEFAULT_SHIFT_MINUTES) : '');

                  const created = addRow(

                    { arrival: baseArrival, departure: baseDeparture },

                    {

                      summaryTrigger: 'add',

                      insertAfter,

                      markSynced: false,

                      groupId: newGroupId,

                      silent: index > 0,

                    },

                  );

                  if (created) {

                    if (!firstNewRow) firstNewRow = created;

                    insertAfter = created;

                  }

                });

                if (firstNewRow && primaryState && primaryState.arrival) {

                  recordDebug('employee-arrival-prefill', {

                    index: firstNewRow.dataset.index,

                    value: primaryState.arrival,

                    multiDay: true,

                    count: groupRows.length,

                  });

                }

                return;

              }

              const baseArrival = (primaryState && primaryState.arrival) || formSessionStartIso;

              const row = addRow(

                {},

                {

                  prefillArrival: baseArrival,

                  prefillDeparture:

                    (primaryState && primaryState.departure) ||

                    addMinutesToIso(baseArrival, DEFAULT_SHIFT_MINUTES),

                  summaryTrigger: 'add',

                },

              );

              if (row && primaryState && primaryState.arrival) {

                recordDebug('employee-arrival-prefill', {

                  index: row.dataset.index,

                  value: primaryState.arrival,

                });

              }

            });

          }



          if (breaksToggleEl) {

            breaksToggleEl.addEventListener('change', () => {

              rowElements().forEach((row) => {

                updateRowState(row, 'break-toggle', {

                  logDebug: false,

                  preserveSyncFlag: true,

                  skipPropagation: true,

                });

              });

              updateSummary('break-toggle');

            });

          }

        }

