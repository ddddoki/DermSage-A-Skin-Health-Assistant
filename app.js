(() => {
    'use strict';

    const SCHEMA_VERSION = 1;
    const RECORDS_PATH = '/api/records';
    const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
    const MAX_IMPORT_SIZE = 8 * 1024 * 1024;
    const MAX_MODEL_IMAGE_SIZE = 2 * 1024 * 1024;
    const MAX_MODEL_IMAGE_EDGE = 1024;
    const MODEL_MODES = { image_text: '图片与文字', image: '图片', text: '文字' };
    const DIFFERENTIAL_CONDITIONS = new Set(['痤疮', '接触性皮炎', '特应性皮炎（湿疹）', '银屑病', '体癣', '荨麻疹']);
    const LIMITS = { title: 80, region: 60, description: 800, days: 3650 };

    const rules = [
        { id: 'urticaria', label: '荨麻疹', words: ['荨麻疹', '风团', '风疹块'] },
        { id: 'psoriasis', label: '银屑病', words: ['银屑病', '牛皮癣', '银白鳞屑', '银白色鳞屑'] },
        { id: 'fungal', label: '皮肤真菌', words: ['皮肤真菌', '真菌', '体癣', '足癣', '股癣', '环状红斑'] },
        { id: 'acne', label: '痤疮', words: ['痤疮', '青春痘', '粉刺', '痘痘'] },
        { id: 'dermatitis', label: '湿疹 / 皮炎', words: ['湿疹', '皮炎', '渗液', '瘙痒', '发痒', '痒'] },
        { id: 'general', label: '通用咨询', words: [] }
    ];
    const topicById = new Map(rules.map(rule => [rule.id, rule]));

    const byId = id => document.getElementById(id);
    const form = byId('case-form');
    const fields = {
        title: byId('case-title'),
        region: byId('case-region'),
        days: byId('case-days'),
        description: byId('case-description'),
        image: byId('case-image')
    };
    const formTitle = byId('form-title');
    const formStatus = byId('form-status');
    const preview = byId('image-preview');
    const imageMeta = byId('image-meta');
    const imageClear = byId('image-clear');
    const runButton = byId('run-analysis');
    const runModelButton = byId('run-model');
    const refreshModelButton = byId('refresh-model-status');
    const modelReadiness = byId('model-readiness');
    const modelStatus = byId('model-status');
    const modelResult = byId('model-result');
    const result = byId('analysis-result');
    const resultTopic = byId('result-topic');
    const resultStatus = byId('result-status');
    const saveButton = byId('save-record');
    const searchInput = byId('history-search');
    const topicFilter = byId('history-topic');
    const historyList = byId('history-list');
    const historyStatus = byId('history-status');
    const historyCount = byId('history-count');
    const exportButton = byId('export-records');
    const importButton = byId('import-records');
    const importFile = byId('import-file');
    const clearButton = byId('clear-records');
    const reloadButton = byId('reload-records');
    const topicList = byId('topic-list');
    const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

    let selection = 0;
    let previewUrl = '';
    let imageInfo = null;
    let editing = null;
    let analysis = null;
    let records = [];
    let recordsReady = false;
    let recordRequestPending = false;
    let modelAvailability = null;
    let checkingModel = false;
    let activeObservation = null;

    function showStatus(element, message = '', type = 'info') {
        element.textContent = message;
        if (message) element.dataset.status = type;
        else delete element.dataset.status;
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        node.textContent = text;
        return node;
    }

    function hideAnalysis() {
        analysis = null;
        result.hidden = true;
        saveButton.disabled = true;
        showStatus(resultStatus);
    }

    function releaseImage() {
        selection += 1;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = '';
        imageInfo = null;
        preview.removeAttribute('src');
        preview.hidden = true;
        runButton.disabled = false;
    }

    function clearImage() {
        releaseImage();
        fields.image.value = '';
        imageClear.disabled = true;
        showStatus(imageMeta, '尚未选择图片。');
        invalidateObservation();
    }

    function signatureMime(bytes) {
        const startsWith = (signature, offset = 0) => signature.every((byte, index) => bytes[offset + index] === byte);
        if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
        if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
        if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
        return '';
    }

    function fileSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    async function selectImage() {
        const file = fields.image.files[0];
        releaseImage();
        hideAnalysis();
        invalidateObservation();
        showStatus(formStatus);
        imageClear.disabled = !file;
        if (!file) {
            showStatus(imageMeta, '尚未选择图片。');
            return;
        }
        const thisSelection = selection;
        runButton.disabled = true;
        updateModelControls();
        showStatus(imageMeta, '正在检查并解码图片…');

        try {
            if (file.size > MAX_IMAGE_SIZE) throw new Error('图片超过 8 MB，请选择较小的图片。');
            const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
            if (thisSelection !== selection) return;
            const mime = signatureMime(bytes);
            if (!mime) throw new Error('请选择有效的 JPG、PNG 或 WEBP 图片。');

            previewUrl = URL.createObjectURL(new Blob([file], { type: mime }));
            const decodedImage = new Image();
            decodedImage.src = previewUrl;
            try {
                await decodedImage.decode();
            } catch {
                throw new Error('图片无法解码，请重新导出图片或选择另一张。');
            }
            if (thisSelection !== selection) return;
            if (!decodedImage.naturalWidth || !decodedImage.naturalHeight) throw new Error('无法读取图片尺寸，请更换图片。');

            imageInfo = { width: decodedImage.naturalWidth, height: decodedImage.naturalHeight, size: file.size, mime };
            preview.src = previewUrl;
            preview.hidden = false;
            runButton.disabled = false;
            updateModelControls();
            showStatus(imageMeta, `${imageInfo.width} × ${imageInfo.height} 像素 · ${fileSize(imageInfo.size)} · ${mime}`, 'success');
        } catch (error) {
            if (thisSelection !== selection) return;
            clearImage();
            showStatus(imageMeta, error.message || '无法读取图片，请重试。', 'error');
        }
    }

    function markInvalid(field, message) {
        field.setAttribute('aria-invalid', 'true');
        showStatus(formStatus, message, 'error');
        field.focus();
        return null;
    }

    function readForm(requireTitle = true) {
        const title = fields.title.value.trim();
        const region = fields.region.value.trim();
        const description = fields.description.value.trim();
        const daysText = fields.days.value;
        const days = daysText === '' ? null : Number(daysText);

        if (requireTitle && (!title || title.length > LIMITS.title)) return markInvalid(fields.title, '请输入 1 至 80 字的记录标题。');
        if (region.length > LIMITS.region) return markInvalid(fields.region, '部位最多填写 60 字。');
        if (fields.days.validity.badInput || (days !== null && (!/^\d+$/.test(daysText) || days > LIMITS.days))) {
            return markInvalid(fields.days, '持续天数请填写 0 至 3650 的整数，或留空。');
        }
        if (description.length > LIMITS.description) return markInvalid(fields.description, '描述最多填写 800 字。');
        if (!description && !imageInfo) return markInvalid(fields.description, '请填写描述或选择一张有效图片。');
        return { title, region, days, description };
    }

    function matchTopic(description) {
        for (const [index, rule] of rules.entries()) {
            const matched = rule.words.filter(word => description.includes(word));
            if (matched.length || rule.id === 'general') return { rule, rank: index + 1, matched };
        }
    }

    function runAnalysis(event) {
        event.preventDefault();
        if (runButton.disabled) return;
        hideAnalysis();
        showStatus(formStatus);
        const record = readForm();
        if (!record) return;
        const { rule, rank, matched } = matchTopic(record.description);
        analysis = { ...record, topic: rule.id };
        resultTopic.textContent = `${rule.label}主题示例`;
        byId('result-keys').textContent = matched.length ? `匹配词：${matched.join('、')}` : '匹配词：无';
        byId('result-basis').textContent = matched.length
            ? `依据：描述命中第 ${rank} 条规则。多组同时命中时采用序号最靠前的一组。`
            : `依据：描述未命中前五组关键词，采用第 ${rank} 条通用规则。`;
        byId('result-image').textContent = imageInfo
            ? `${imageInfo.width} × ${imageInfo.height} 像素 · ${fileSize(imageInfo.size)} · ${imageInfo.mime}`
            : '未选择图片。';
        saveButton.textContent = editing ? '更新记录' : '保存记录';
        result.hidden = false;
        updateRecordControls();
        resultTopic.focus();
    }

    function updateModelControls() {
        runModelButton.disabled = !modelAvailability?.ready || checkingModel || !!activeObservation || runButton.disabled;
        refreshModelButton.disabled = checkingModel || !!activeObservation;
        modelResult.setAttribute('aria-busy', String(!!activeObservation));
    }

    function invalidateObservation() {
        activeObservation?.abort();
        activeObservation = null;
        modelResult.hidden = true;
        showStatus(modelStatus);
        updateModelControls();
    }

    function apiError(data) {
        if (typeof data?.error === 'string' && data.error) return data.error;
        if (typeof data?.detail === 'string' && data.detail) return data.detail;
        if (Array.isArray(data?.detail)) return '观察输入格式有误，请检查图片和文字后重试。';
        return '本机模型服务未能完成请求，请检查模型状态后重试。';
    }

    async function modelRequest(path, options = {}) {
        if (location.protocol === 'file:') throw new Error('请启动 DermSage 本机服务，再打开终端显示的网址。');
        let response;
        try {
            response = await fetch(path, { cache: 'no-store', ...options });
        } catch {
            if (options.signal?.aborted) throw new Error('本机模型请求等待超时，请重试。');
            throw new Error('无法连接本机服务，请确认服务正在运行后重试。');
        }
        let data;
        try {
            data = await response.json();
        } catch {
            throw new Error('本机服务返回了无法读取的模型响应，请重试。');
        }
        if (!response.ok) throw new Error(apiError(data));
        return data;
    }

    async function checkModel() {
        if (checkingModel || activeObservation) return;
        checkingModel = true;
        updateModelControls();
        showStatus(modelReadiness, '正在检查模型状态…');
        try {
            const data = await modelRequest('/api/model-status', { signal: AbortSignal.timeout(15000) });
            if (typeof data?.ready !== 'boolean') throw new Error('本机服务返回的模型状态有误。');
            modelAvailability = data;
            if (data.ready) {
                const name = typeof data.model === 'string' && data.model ? `（${data.model}）` : '';
                showStatus(modelReadiness, `本机模型已就绪${name}。`, 'success');
            } else {
                showStatus(modelReadiness, data.message || '模型尚未就绪。请启动本机模型并再次检查。', 'error');
            }
        } catch (error) {
            modelAvailability = null;
            showStatus(modelReadiness, error.message, 'error');
        } finally {
            checkingModel = false;
            updateModelControls();
        }
    }

    async function encodeObservationImage(signal) {
        if (!imageInfo) return null;
        const { width, height } = imageInfo;
        const scale = Math.min(1, MAX_MODEL_IMAGE_EDGE / Math.max(width, height));
        await preview.decode();
        signal.throwIfAborted();

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('浏览器无法处理图片，请尝试选择另一张图片。');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(preview, 0, 0, canvas.width, canvas.height);

        for (const quality of [0.84, 0.68, 0.52]) {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
            signal.throwIfAborted();
            if (!blob || blob.type !== 'image/jpeg' || blob.size > MAX_MODEL_IMAGE_SIZE) continue;
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result).split(',')[1]);
                reader.onerror = () => reject(new Error('读取处理后的图片失败，请重新选择图片。'));
                reader.readAsDataURL(blob);
            });
        }
        throw new Error('无法将图片处理到发送上限，请选择更小的图片。');
    }

    function renderObservation(data) {
        const validText = value => typeof value === 'string' && !!value.trim();
        const validList = value => Array.isArray(value) && value.every(validText);
        if (!data || !Object.hasOwn(MODEL_MODES, data.input_mode) || !validText(data.model)
            || !validText(data.image_quality) || !validText(data.summary)
            || !validList(data.observations) || !validList(data.follow_up_questions)) {
            throw new Error('本机服务返回的观察结果格式有误，请重试。');
        }
        renderDifferential(data);
        byId('model-result-name').textContent = data.model;
        byId('model-result-mode').textContent = MODEL_MODES[data.input_mode];
        byId('model-result-quality').textContent = data.image_quality;
        byId('model-result-observations').replaceChildren(...(data.observations.length ? data.observations : ['未返回观察要点。'])
            .map(text => element('li', '', text)));
        const defaultQuestion = data.differential_status === 'insufficient'
            ? '能否补充清晰照片或更具体的观察描述？' : '暂无需要补充的信息。';
        byId('model-result-questions').replaceChildren(...(data.follow_up_questions.length ? data.follow_up_questions : [defaultQuestion])
            .map(text => element('li', '', text)));
        byId('model-result-summary').textContent = data.summary;
        modelResult.hidden = false;
        byId('model-result-title').focus();
    }

    function renderDifferential({ differential_status: status, candidates }) {
        const validCandidateText = value => typeof value === 'string' && !!value.trim() && [...value].length <= 160;
        const validCandidate = value => value && DIFFERENTIAL_CONDITIONS.has(value.condition)
            && validCandidateText(value.evidence) && validCandidateText(value.uncertainty);
        const insufficient = status === 'insufficient';
        const validList = Array.isArray(candidates) && (insufficient
            ? candidates.length === 0
            : status === 'candidates' && candidates.length >= 1 && candidates.length <= 3
                && candidates.every(validCandidate) && new Set(candidates.map(item => item.condition)).size === candidates.length);
        if (!validList) throw new Error('本机服务返回的候选病种格式有误，请重试。');

        const message = byId('model-differential-message');
        const list = byId('model-candidates');
        message.textContent = insufficient ? '当前证据不足，暂不列出候选病种。请参考下方问题补充信息。' : '';
        message.hidden = !insufficient;
        list.hidden = insufficient;
        list.replaceChildren(...candidates.map(({ condition, evidence, uncertainty }) => {
            const item = element('li', '', '');
            const details = element('dl', '', '');
            for (const [label, text] of [['支持线索', evidence], ['不确定点', uncertainty]]) {
                const entry = element('div', '', '');
                entry.append(element('dt', '', label), element('dd', '', text));
                details.append(entry);
            }
            item.append(element('strong', '', condition), details);
            return item;
        }));
    }

    async function runObservation() {
        if (runModelButton.disabled) return;
        modelResult.hidden = true;
        showStatus(formStatus);
        const record = readForm(false);
        if (!record) {
            showStatus(modelStatus, '请检查上方表单，再查看鉴别参考。', 'error');
            return;
        }
        const { description, region, days } = record;
        const request = new AbortController();
        activeObservation = request;
        updateModelControls();
        const timeout = setTimeout(() => request.abort(), 195000);
        try {
            showStatus(modelStatus, imageInfo ? '正在处理本次图片…' : '正在发送本次文字…');
            const image = await encodeObservationImage(request.signal);
            request.signal.throwIfAborted();
            showStatus(modelStatus, '本机模型正在整理观察信息与鉴别参考…');
            const data = await modelRequest('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description, region, days, image }),
                signal: request.signal
            });
            if (activeObservation !== request) return;
            renderObservation(data);
            showStatus(modelStatus, '已生成本次鉴别参考。', 'success');
        } catch (error) {
            if (activeObservation === request) {
                showStatus(modelStatus, request.signal.aborted ? '本机模型请求等待超时，请重试。' : error.message, 'error');
            }
        } finally {
            clearTimeout(timeout);
            if (activeObservation === request) {
                activeObservation = null;
                updateModelControls();
            }
        }
    }

    function validDate(value) {
        return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
            && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    }

    function validRecord(record) {
        return record && typeof record === 'object'
            && typeof record.id === 'string' && /^[\da-f]{32}$/.test(record.id)
            && typeof record.title === 'string' && record.title.trim().length > 0 && record.title.length <= LIMITS.title
            && typeof record.region === 'string' && record.region.length <= LIMITS.region
            && (record.days === null || (Number.isInteger(record.days) && record.days >= 0 && record.days <= LIMITS.days))
            && typeof record.description === 'string' && record.description.length <= LIMITS.description
            && topicById.has(record.topic) && validDate(record.createdAt) && validDate(record.updatedAt);
    }

    function storedFields({ id, title, region, days, description, topic, createdAt, updatedAt }) {
        return { id, title, region, days, description, topic, createdAt, updatedAt };
    }

    class RecordRequestError extends Error {
        constructor(message, status = 0) {
            super(message);
            this.status = status;
        }
    }

    // 文本记录通过同源服务读写，图片仅用于当前页面预览。
    async function requestRecords(method, path = RECORDS_PATH, payload) {
        if (location.protocol === 'file:') {
            throw new RecordRequestError('请启动 DermSage 本机服务，再打开终端显示的网址。', 400);
        }

        const options = { method, cache: 'no-store', signal: AbortSignal.timeout(15000) };
        if (payload) {
            options.headers = { 'Content-Type': 'application/json' };
            options.body = JSON.stringify(payload);
        }
        let response;
        try {
            response = await fetch(path, options);
        } catch {
            throw new RecordRequestError('无法连接本机服务。请确认服务正在运行后重试。');
        }

        if (response.status === 204) return null;
        let data;
        try {
            data = await response.json();
        } catch {
            throw new RecordRequestError('本机服务返回了无法读取的结果。', response.ok ? 0 : response.status);
        }
        if (!response.ok) {
            throw new RecordRequestError(typeof data?.error === 'string' && data.error
                ? data.error : '本机服务未能完成该操作。', response.status);
        }
        return data;
    }

    async function refreshRecords(keepPreviousOnError = false) {
        try {
            const data = await requestRecords('GET');
            if (!Array.isArray(data?.records) || !data.records.every(validRecord)
                || new Set(data.records.map(record => record.id)).size !== data.records.length) {
                throw new RecordRequestError('本机服务返回的记录格式有误。');
            }
            records = data.records.map(storedFields);
            recordsReady = true;
        } catch (error) {
            if (!keepPreviousOnError) recordsReady = false;
            showStatus(historyStatus, error.message, 'error');
            throw error;
        } finally {
            renderHistory();
        }
    }

    // 同一页面仅执行一条记录操作，避免读取和修改互相覆盖。
    async function withRecordRequest(status, operation) {
        if (recordRequestPending) return;
        recordRequestPending = true;
        updateRecordControls();
        showStatus(status, '正在连接本机数据库…');
        try {
            await operation();
        } catch (error) {
            showStatus(status, error.message, 'error');
        } finally {
            recordRequestPending = false;
            updateRecordControls();
        }
    }

    async function reloadRecords() {
        await withRecordRequest(historyStatus, async () => {
            await refreshRecords();
            showStatus(historyStatus, '已读取本机数据库。', 'success');
        });
    }

    async function refreshAfterChange(message) {
        try {
            await refreshRecords();
            showStatus(historyStatus, message, 'success');
        } catch {
            // 修改已完成。列表读取失败时，保留刷新操作的错误提示。
        }
    }

    function showEditorMode() {
        formTitle.textContent = editing ? '编辑记录' : '新建记录';
        saveButton.textContent = editing ? '更新记录' : '保存记录';
    }

    async function saveAnalysis() {
        if (!analysis || saveButton.disabled) return;
        const current = editing;
        const payload = current ? { ...analysis, expectedUpdatedAt: current.updatedAt } : analysis;
        await withRecordRequest(resultStatus, async () => {
            form.inert = true;
            try {
                const data = current
                    ? await requestRecords('PUT', `${RECORDS_PATH}/${current.id}`, payload)
                    : await requestRecords('POST', RECORDS_PATH, payload);
                if (!validRecord(data?.record)) throw new RecordRequestError('本机服务未返回有效的记录。');
                editing = { id: data.record.id, updatedAt: data.record.updatedAt };
                analysis = null;
                showEditorMode();
                const message = current ? '记录已更新。' : '记录已保存到本机数据库。';
                showStatus(resultStatus, message, 'success');
                await refreshAfterChange(message);
            } catch (error) {
                if (current && (error.status === 409 || error.status === 404)) {
                    analysis = null;
                    await refreshAfterChange('已重新读取记录。');
                    throw new Error('这条记录已在其他页面修改或删除。请重新载入记录，或清空表单后新建。');
                }
                if (error.status === 0 || error.status >= 500) {
                    analysis = null;
                    await refreshAfterChange('已重新读取记录，请核对操作是否生效。');
                    throw new Error(`${error.message} 请核对列表中的记录，再决定是否重新提交。`);
                }
                throw error;
            } finally {
                form.inert = false;
            }
        });
    }

    function clearInvalidFields() {
        for (const field of Object.values(fields)) field.removeAttribute('aria-invalid');
    }

    function resetForm() {
        form.reset();
        clearImage();
        clearInvalidFields();
        editing = null;
        hideAnalysis();
        showEditorMode();
        showStatus(formStatus);
    }

    function loadRecord(record) {
        resetForm();
        fields.title.value = record.title;
        fields.region.value = record.region;
        fields.days.value = record.days ?? '';
        fields.description.value = record.description;
        editing = { id: record.id, updatedAt: record.updatedAt };
        showEditorMode();
        showStatus(formStatus, '已载入记录文字。修改后点击“查看匹配结果”，再更新记录。', 'success');
        fields.title.focus();
    }

    async function loadLatestRecord(id) {
        await withRecordRequest(historyStatus, async () => {
            await refreshRecords();
            const record = records.find(item => item.id === id);
            if (!record) throw new Error('这条记录已被删除。');
            loadRecord(record);
            showStatus(historyStatus, '已载入数据库中的最新记录。', 'success');
        });
    }

    function discardEditorAfterRemoval() {
        editing = null;
        hideAnalysis();
        showEditorMode();
        showStatus(formStatus, '原记录已移除。表单内容仍可用于新建记录。');
    }

    async function deleteRecord(selectedRecord) {
        await withRecordRequest(historyStatus, async () => {
            await refreshRecords();
            const record = records.find(item => item.id === selectedRecord.id);
            if (!record) {
                if (editing?.id === selectedRecord.id) discardEditorAfterRemoval();
                showStatus(historyStatus, '记录已移除。', 'success');
                return;
            }
            if (record.updatedAt !== selectedRecord.updatedAt) {
                throw new Error('这条记录刚刚更新。请核对更新后的内容，再选择删除。');
            }
            try {
                await requestRecords('DELETE', `${RECORDS_PATH}/${record.id}`);
            } catch (error) {
                await refreshAfterChange('已重新读取记录，请核对操作是否生效。');
                throw error;
            }
            if (editing?.id === record.id) discardEditorAfterRemoval();
            await refreshAfterChange('记录已删除。');
        });
    }

    async function clearRecords() {
        await withRecordRequest(historyStatus, async () => {
            await refreshRecords();
            if (!records.length) {
                showStatus(historyStatus, '暂无已保存的记录。');
                return;
            }
            if (!window.confirm('确定清空 DermSage 的全部本地记录？清空后无法在软件内恢复。')) {
                showStatus(historyStatus);
                return;
            }
            try {
                await requestRecords('DELETE');
            } catch (error) {
                await refreshAfterChange('已重新读取记录，请核对操作是否生效。');
                throw error;
            }
            if (editing) discardEditorAfterRemoval();
            await refreshAfterChange('已清空本地记录。');
        });
    }

    function currentFilters() {
        return { query: searchInput.value.trim(), topic: topicFilter.value };
    }

    function filteredRecords({ query, topic }) {
        const keyword = query.toLowerCase();
        return records.filter(record => (!topic || record.topic === topic)
            && [record.title, record.description, record.region].some(value => value.toLowerCase().includes(keyword)));
    }

    function recordCard(record) {
        const card = element('article', 'history-card', '');
        const heading = element('h3', '', record.title);
        const meta = [topicById.get(record.topic).label, record.region, record.days === null ? '' : `持续 ${record.days} 天`,
            `更新于 ${dateFormat.format(new Date(record.updatedAt))}`].filter(Boolean).join(' · ');
        const load = element('button', 'button button-secondary', '载入记录');
        const remove = element('button', 'button button-danger', '删除');
        load.type = remove.type = 'button';
        load.setAttribute('aria-label', `载入记录 ${record.title}`);
        remove.setAttribute('aria-label', `删除记录 ${record.title}`);
        load.addEventListener('click', () => loadLatestRecord(record.id));
        remove.addEventListener('click', () => deleteRecord(record));
        const actions = element('div', 'history-actions', '');
        actions.append(load, remove);
        card.append(heading, element('p', 'history-meta', meta), element('p', 'history-summary', record.description || '未填写文字描述。'), actions);
        return card;
    }

    function updateRecordControls() {
        saveButton.disabled = recordRequestPending || !analysis;
        reloadButton.disabled = recordRequestPending;
        importButton.disabled = recordRequestPending;
        exportButton.disabled = recordRequestPending || !recordsReady || !filteredRecords(currentFilters()).length;
        clearButton.disabled = recordRequestPending || !recordsReady || !records.length;
        historyList.setAttribute('aria-busy', String(recordRequestPending));
        for (const button of historyList.querySelectorAll('button')) {
            button.disabled = recordRequestPending;
        }
    }

    function renderHistory() {
        const shown = recordsReady ? filteredRecords(currentFilters()) : [];
        historyCount.textContent = recordsReady ? `显示 ${shown.length} 条，共 ${records.length} 条` : '暂未读取记录';
        historyList.replaceChildren(...shown.map(recordCard));
        if (!shown.length) {
            const empty = !recordsReady ? '点击刷新记录可重新读取本机数据库。'
                : records.length ? '当前筛选条件下没有匹配记录。' : '暂无已保存的记录。';
            historyList.append(element('p', 'empty-state', empty));
        }
        updateRecordControls();
    }

    async function exportRecords() {
        await withRecordRequest(historyStatus, async () => {
            await refreshRecords();
            const filters = currentFilters();
            const selectedRecords = filteredRecords(filters);
            if (!selectedRecords.length) {
                showStatus(historyStatus, '当前筛选条件下没有可导出的记录。');
                return;
            }
            const exportedAt = new Date().toISOString();
            const data = { software: 'DermSage皮肤健康助手软件', version: 'V1.0', schemaVersion: SCHEMA_VERSION, exportedAt, filters, records: selectedRecords };
            const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = `DermSage-records-${exportedAt.slice(0, 10)}.json`;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            showStatus(historyStatus, `已生成 ${selectedRecords.length} 条筛选记录的 JSON 下载。`, 'success');
        });
    }

    async function importRecords() {
        const file = importFile.files[0];
        importFile.value = '';
        if (!file) return;
        await withRecordRequest(historyStatus, async () => {
            if (file.size > MAX_IMPORT_SIZE) throw new Error('JSON 文件超过 8 MiB，请选择较小的文件。');
            showStatus(historyStatus, '正在读取 JSON 文件…');
            let payload;
            try {
                payload = JSON.parse(await file.text());
            } catch {
                throw new Error('无法读取有效的 JSON，请选择 DermSage 导出的记录文件。');
            }
            if (!payload || !Array.isArray(payload.records)) {
                throw new Error('文件缺少记录列表，请选择 DermSage 导出的记录文件。');
            }

            showStatus(historyStatus, '正在导入记录…');
            const data = await requestRecords('POST', `${RECORDS_PATH}/import`, payload);
            if (!Number.isInteger(data?.imported) || data.imported < 0
                || !Number.isInteger(data.skipped) || data.skipped < 0) {
                throw new Error('本机服务返回的导入结果有误。请刷新记录核对。');
            }
            const message = `已导入 ${data.imported} 条，跳过重复记录 ${data.skipped} 条。`;
            try {
                await refreshRecords(true);
                showStatus(historyStatus, message, 'success');
            } catch {
                showStatus(historyStatus, `${message} 列表暂未刷新，请点击“刷新记录”。`, 'error');
            }
        });
    }

    function initializeRules() {
        for (const [index, rule] of rules.entries()) {
            topicFilter.add(new Option(rule.label, rule.id));
            const item = element('li', 'topic-rule', '');
            item.append(element('strong', 'topic-rule-title', `${index + 1}. ${rule.label}`),
                element('p', '', rule.words.length ? rule.words.join('、') : '前五条规则均未命中时使用。'));
            topicList.append(item);
        }
    }

    for (const field of [fields.title, fields.region, fields.days, fields.description]) {
        field.addEventListener('input', () => {
            field.removeAttribute('aria-invalid');
            hideAnalysis();
            showStatus(formStatus);
            if (field !== fields.title) invalidateObservation();
        });
    }
    fields.image.addEventListener('change', selectImage);
    imageClear.addEventListener('click', () => { clearImage(); hideAnalysis(); });
    byId('form-reset').addEventListener('click', resetForm);
    form.addEventListener('submit', runAnalysis);
    runModelButton.addEventListener('click', runObservation);
    refreshModelButton.addEventListener('click', checkModel);
    saveButton.addEventListener('click', saveAnalysis);
    searchInput.addEventListener('input', () => renderHistory());
    topicFilter.addEventListener('change', () => renderHistory());
    clearButton.addEventListener('click', clearRecords);
    exportButton.addEventListener('click', exportRecords);
    importButton.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', importRecords);
    reloadButton.addEventListener('click', reloadRecords);
    window.addEventListener('pageshow', event => { if (event.persisted) reloadRecords(); });
    window.addEventListener('pagehide', event => { if (!event.persisted && previewUrl) URL.revokeObjectURL(previewUrl); });

    initializeRules();
    renderHistory();
    reloadRecords();
    checkModel();
})();
