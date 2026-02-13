// ==UserScript==
// @name         Wayfarer Exporter Optimized
// @version      0.10.0
// @description  Export nominations data from Wayfarer to IITC via Google Sheets
// @namespace    https://github.com/Editst/wayfarer/
// @downloadURL  https://github.com/Editst/wayfarer/raw/main/wayfarer-exporter.user.js
// @updateURL    https://github.com/Editst/wayfarer/raw/main/wayfarer-exporter.user.js
// @match        https://opr.ingress.com/*
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

/* eslint-env es6 */

(function () {
    'use strict';

    const CONFIG = {
        MAX_CONCURRENT_UPLOADS: 3,
        CACHE_DURATION: 12 * 60 * 60 * 1000,
        RETRY_LIMIT: 3,
        API_PROFILE: 'https://opr.ingress.com/api/v1/vault/properties'
    };

    class WayfarerExporter {
        constructor() {
            this.queue = [];
            this.activeUploads = 0;
            this.candidates = {};
            this.sentNominations = null;
            this.profileName = null;
            this.logger = null;
            
            this.init();
        }

        init() {
            this.interceptXHR();
            this.observeUI();
            this.loadProfileName();
        }

        interceptXHR() {
            const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const originalOpen = win.XMLHttpRequest.prototype.open;
            const self = this;

            win.XMLHttpRequest.prototype.open = function (method, url) {
                if (url.includes('/api/v1/vault/manage') && method === 'GET') {
                    this.addEventListener('load', (e) => self.handleNominationsLoad(e), false);
                }
                return originalOpen.apply(this, arguments);
            };
        }

        observeUI() {
            const observer = new MutationObserver((mutations, obs) => {
                const sidebar = document.querySelector('.sidebar-link[href$="nominations"]');
                if (sidebar) {
                    this.addConfigurationButton(sidebar);
                    obs.disconnect();
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }

        handleNominationsLoad(event) {
            try {
                const response = event.target.response;
                const json = JSON.parse(response);
                const rawSubmissions = json?.result?.submissions;

                if (!rawSubmissions) {
                    this.log('Error: Failed to parse nominations data.');
                    return;
                }

                // [改进] 参考 0.11：过滤掉非申请类型（如编辑请求）
                this.sentNominations = rawSubmissions.filter(n => n.type === 'NOMINATION');
                
                setTimeout(() => this.analyzeCandidates(), 500);
            } catch (e) {
                console.error('[Wayfarer Exporter] JSON Parse Error:', e);
            }
        }

        async analyzeCandidates() {
            if (!this.sentNominations) return;

            const storedCandidates = await this.getAllCandidates();
            if (!storedCandidates) return;

            this.candidates = storedCandidates;
            this.log(`Analyzing ${this.sentNominations.length} nominations...`);

            // [核心] 防止死循环的 ID 白名单
            const currentApiIds = new Set(this.sentNominations.map(n => n.id));
            let modified = false;
            
            for (const nomination of this.sentNominations) {
                if (await this.checkNomination(nomination, currentApiIds)) {
                    modified = true;
                }
            }

            if (modified) {
                this.saveLocalCandidates();
                this.log('Updates processed.');
            } else {
                this.log('No changes detected.');
                setTimeout(() => this.removeLogger(), 3000);
            }
        }

        async checkNomination(nomination, currentApiIds) {
            const id = nomination.id;
            const existing = this.candidates[id];
            const currentStatus = this.statusConvertor(nomination.status);

            // 1. 处理已存在的记录
            if (existing) {
                if (nomination.status === 'ACCEPTED') {
                    this.log(`Approved: ${nomination.title}`);
                    this.queueUpdate(nomination, 'delete'); 
                    delete this.candidates[id];
                    return true;
                }

                if (currentStatus !== existing.status) {
                    this.candidates[id].status = currentStatus;
                    this.queueUpdate(nomination, currentStatus);
                    this.log(`Status Changed: ${nomination.title} -> ${currentStatus}`);
                    return true;
                }

                if (nomination.title !== existing.title || nomination.description !== existing.description) {
                    this.candidates[id].title = nomination.title;
                    this.candidates[id].description = nomination.description;
                    this.queueUpdate(nomination, currentStatus);
                    this.log(`Info Updated: ${nomination.title}`);
                    return true;
                }
                return false;
            }

            // 2. 处理新记录 (包括 NIANTIC_REVIEW)
            // [改进] 增加 NIANTIC_REVIEW 支持
            if (['NOMINATED', 'VOTING', 'HELD', 'APPEALED', 'NIANTIC_REVIEW'].includes(nomination.status)) {
                
                const cell17id = S2Helper.getCellId(nomination.lat, nomination.lng);
                
                // 智能查重与替换逻辑
                Object.keys(this.candidates).forEach(idx => {
                    const candidate = this.candidates[idx];
                    
                    // [双重保护]
                    // 1. 如果该 ID 存在于 API 中，绝对不是手动条目，跳过。
                    if (currentApiIds.has(idx)) return; 
                    
                    // 2. [改进] 仅当本地条目状态为 'potential' 时才考虑替换 (参考 0.11)
                    // 这意味着如果你已经在 Sheet 里把它改成 submitted 了，脚本就不会动它，增加了安全性。
                    // 如果你希望脚本更激进地替换，可以注释掉 `&& candidate.status === 'potential'`
                    const isPotential = candidate.status === 'potential';

                    if (candidate.cell17id === cell17id && isPotential) {
                        const dist = S2Helper.getDistance(candidate, nomination);
                        const sameTitle = candidate.title === nomination.title;

                        // [改进] 采用更智能的距离判断 (参考 0.11)
                        // 相同标题允许 10m 误差，不同标题仅允许 3m 误差
                        if ((sameTitle && dist < 10) || dist < 3) {
                            this.log(`Found manual entry match for ${candidate.title} (${dist.toFixed(1)}m), replacing.`);
                            this.queueUpdate({id: idx}, 'delete');
                            delete this.candidates[idx];
                        }
                    }
                });

                this.candidates[id] = {
                    cell17id: cell17id,
                    title: nomination.title,
                    description: nomination.description,
                    lat: nomination.lat,
                    lng: nomination.lng,
                    status: currentStatus
                };
                
                this.log(`New Candidate: ${nomination.title}`);
                this.queueUpdate(nomination, currentStatus);
                return true;
            }
            return false;
        }

        queueUpdate(nomination, status) {
            this.getProfileName().then(nickname => {
                const formData = new FormData();
                formData.retries = CONFIG.RETRY_LIMIT;
                formData.append('status', status);
                formData.append('id', nomination.id);
                if (status !== 'delete') {
                    formData.append('lat', nomination.lat);
                    formData.append('lng', nomination.lng);
                    formData.append('title', nomination.title);
                    formData.append('description', nomination.description);
                    formData.append('submitteddate', nomination.day || '');
                    formData.append('candidateimageurl', nomination.imageUrl || '');
                    formData.append('nickname', nickname);
                }
                this.queue.push(formData);
                this.processQueue();
            });
        }

        processQueue() {
            if (this.activeUploads >= CONFIG.MAX_CONCURRENT_UPLOADS || this.queue.length === 0) return;

            const formData = this.queue.shift();
            this.activeUploads++;
            this.updateLogUI();

            const url = localStorage['wayfarerexporter-url'];
            
            fetch(url, { method: 'POST', body: formData })
            .then(() => {})
            .catch(error => {
                console.error('Upload failed', error);
                formData.retries--;
                if (formData.retries > 0) this.queue.push(formData);
                else this.log(`Failed to sync: ${formData.get('title')}`);
            })
            .finally(() => {
                this.activeUploads--;
                this.updateLogUI();
                this.processQueue();
            });
        }

        async getAllCandidates() {
            const storedData = localStorage['wayfarerexporter-candidates'];
            const lastUpdate = localStorage['wayfarerexporter-lastupdate'] || 0;
            const now = Date.now();

            if (!storedData || (now - lastUpdate) > CONFIG.CACHE_DURATION) {
                return await this.loadPlannerData();
            }
            return JSON.parse(storedData);
        }

        async loadPlannerData(customUrl) {
            let url = customUrl || localStorage['wayfarerexporter-url'];
            if (!url) {
                url = window.prompt('Please enter your Google Script URL for Wayfarer Planner:');
                if (!url) return null;
            }

            try {
                this.log('Loading data from spreadsheet...');
                const response = await fetch(url);
                const data = await response.json();
                
                // [改进] 增加了 niantic_review 状态的支持
                const activeStatus = ['submitted', 'potential', 'held', 'rejected', 'appealed', 'voting', 'niantic_review'];
                const submitted = data.filter(c => activeStatus.includes(c.status));

                const candidates = {};
                submitted.forEach(c => {
                    candidates[c.id] = {
                        cell17id: S2Helper.getCellId(c.lat, c.lng),
                        title: c.title,
                        description: c.description,
                        lat: c.lat,
                        lng: c.lng,
                        status: c.status
                    };
                });

                localStorage['wayfarerexporter-url'] = url;
                localStorage['wayfarerexporter-lastupdate'] = Date.now();
                localStorage['wayfarerexporter-candidates'] = JSON.stringify(candidates);
                
                this.log(`Loaded ${Object.keys(candidates).length} active candidates.`);
                return candidates;
            } catch (e) {
                this.log('Failed to load data from spreadsheet.');
                return null;
            }
        }

        saveLocalCandidates() {
            localStorage['wayfarerexporter-candidates'] = JSON.stringify(this.candidates);
        }

        async getProfileName() {
            if (this.profileName) return this.profileName;
            
            const cached = localStorage.getItem('wayfarerexporter-nickname');
            if (cached) {
                this.profileName = cached;
                return cached;
            }

            try {
                // [改进] 使用新的 API 域名
                const res = await fetch(CONFIG.API_PROFILE);
                const json = await res.json();
                this.profileName = json.result.socialProfile.name;
                localStorage.setItem('wayfarerexporter-nickname', this.profileName);
                return this.profileName;
            } catch (e) {
                return 'wayfarer_user';
            }
        }
        
        loadProfileName() { this.getProfileName(); }

        statusConvertor(status) {
            // [改进] 映射表更加完善
            const map = {
                'HELD': 'held',
                'NOMINATED': 'submitted',
                'VOTING': 'voting', // 区分 submitted 和 voting 更有用
                'NIANTIC_REVIEW': 'niantic_review', // 新增
                'REJECTED': 'rejected',
                'DUPLICATE': 'rejected',
                'WITHDRAWN': 'rejected',
                'APPEALED': 'appealed'
            };
            return map[status] || 'submitted';
        }

        addConfigurationButton(referenceNode) {
            if (document.querySelector('.sidebar-wayfarerexporter')) return;
            this.injectStyles();
            const link = document.createElement('a');
            link.className = 'mat-tooltip-trigger sidebar-link sidebar-wayfarerexporter';
            link.title = 'Sync to IITC';
            link.innerHTML = `<svg viewBox="0 0 24 24" class="sidebar-link__icon" style="width:24px;height:24px;fill:currentColor"><path d="M12,1L8,5H11V14H13V5H16M18,23H6C4.89,23 4,22.1 4,21V9A2,2 0 0,1 6,7H9V9H6V21H18V9H15V7H18A2,2 0 0,1 20,9V21A2,2 0 0,1 18,23Z" /></svg><span> Exporter</span>`;
            referenceNode.parentNode.insertBefore(link, referenceNode.nextSibling);
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const currentUrl = localStorage['wayfarerexporter-url'];
                const url = window.prompt('Script Url for Wayfarer Planner', currentUrl);
                if (url) {
                    this.loadPlannerData(url).then(c => {
                        this.candidates = c || {};
                        this.analyzeCandidates();
                    });
                }
            });
        }

        log(msg) {
            if (!this.logger) this.createLogger();
            const line = document.createElement('div');
            line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
            this.msgLog.appendChild(line);
            this.msgLog.scrollTop = this.msgLog.scrollHeight;
        }
        
        updateLogUI() {
             if(this.statusLog) {
                 const remaining = this.queue.length + this.activeUploads;
                 this.statusLog.textContent = remaining === 0 ? "All synced." : `Syncing... Remaining: ${remaining}`;
             }
        }

        createLogger() {
            this.logger = document.createElement('div');
            this.logger.className = 'wayfarer-exporter_log';
            this.logger.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #ccc;padding-bottom:5px;margin-bottom:5px;">
                    <h3 style="margin:0;font-size:16px;">Exporter Log</h3>
                    <span class="close-btn" style="cursor:pointer;font-weight:bold;">✕</span>
                </div>
                <div class="log-status" style="font-weight:bold;margin-bottom:5px;color:#007bff;"></div>
                <div class="log-wrapper" style="max-height:200px;overflow-y:auto;font-size:12px;"></div>
            `;
            document.body.appendChild(this.logger);
            this.logger.querySelector('.close-btn').onclick = () => this.removeLogger();
            this.msgLog = this.logger.querySelector('.log-wrapper');
            this.statusLog = this.logger.querySelector('.log-status');
        }

        removeLogger() {
            if (this.logger) {
                this.logger.remove();
                this.logger = null;
                this.msgLog = null;
            }
        }

        injectStyles() {
            const style = document.createElement('style');
            style.textContent = `.wayfarer-exporter_log { position: fixed; top: 10px; right: 10px; z-index: 9999; background: white; padding: 10px; border-radius: 4px; box-shadow: 0 2px 10px rgba(0,0,0,0.2); width: 300px; font-family: sans-serif; color: #333; }`;
            document.head.appendChild(style);
        }
    }

    const S2Helper = {
        getCellId: function(lat, lng, level = 17) {
            const d2r = Math.PI / 180.0;
            const xyz = (function() {
                const phi = lat * d2r;
                const theta = lng * d2r;
                const cosphi = Math.cos(phi);
                return [Math.cos(theta) * cosphi, Math.sin(theta) * cosphi, Math.sin(phi)];
            })();
            const faceXYZToUV = function(face, xyz) {
                let u, v;
                switch (face) {
                    case 0: u = xyz[1]/xyz[0]; v = xyz[2]/xyz[0]; break;
                    case 1: u = -xyz[0]/xyz[1]; v = xyz[2]/xyz[1]; break;
                    case 2: u = -xyz[0]/xyz[2]; v = -xyz[1]/xyz[2]; break;
                    case 3: u = xyz[2]/xyz[0]; v = xyz[1]/xyz[0]; break;
                    case 4: u = xyz[2]/xyz[1]; v = -xyz[0]/xyz[1]; break;
                    case 5: u = -xyz[1]/xyz[2]; v = -xyz[0]/xyz[2]; break;
                }
                return [u, v];
            };
            const largestAbsComponent = function(xyz) {
                const temp = [Math.abs(xyz[0]), Math.abs(xyz[1]), Math.abs(xyz[2])];
                if (temp[0] > temp[1]) return temp[0] > temp[2] ? 0 : 2;
                return temp[1] > temp[2] ? 1 : 2;
            };
            let face = largestAbsComponent(xyz);
            if (xyz[face] < 0) face += 3;
            const uv = faceXYZToUV(face, xyz);
            const STToIJ = function(st, order) {
                const maxSize = 1 << order;
                const val = Math.floor(st * maxSize);
                return Math.max(0, Math.min(maxSize - 1, val));
            };
            const UVToST = function(uv) {
                if (uv >= 0) return 0.5 * Math.sqrt(1 + 3 * uv);
                return 1 - 0.5 * Math.sqrt(1 - 3 * uv);
            };
            const st = [UVToST(uv[0]), UVToST(uv[1])];
            const ij = [STToIJ(st[0], level), STToIJ(st[1], level)];
            return `F${face}ij[${ij[0]},${ij[1]}]@${level}`;
        },
        getDistance: function(p1, p2) {
            const R = 6378137;
            const dLat = (p2.lat - p1.lat) * Math.PI / 180;
            const dLong = (p2.lng - p1.lng) * Math.PI / 180;
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.sin(dLong / 2) * Math.sin(dLong / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        }
    };

    new WayfarerExporter();
})();
