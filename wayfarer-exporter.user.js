// ==UserScript==
// @name         Wayfarer Exporter Optimized
// @version      0.11.0
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
        SYNC_TIMEOUT: 15000, // 增加 15 秒超时控制
        API_PROFILE: 'https://opr.ingress.com/api/v1/vault/properties',
        API_MANAGE: '/api/v1/vault/manage'
    };

    /**
     * 存储服务模块：负责安全的本地数据读写
     */
    class StorageService {
        static getUrl() { return localStorage.getItem('wayfarerexporter-url'); }
        static setUrl(url) { localStorage.setItem('wayfarerexporter-url', url); }

        static getNickname() { return localStorage.getItem('wayfarerexporter-nickname'); }
        static setNickname(name) { localStorage.setItem('wayfarerexporter-nickname', name); }

        static getCandidates() {
            try {
                const data = localStorage.getItem('wayfarerexporter-candidates');
                return data ? JSON.parse(data) : null;
            } catch (e) {
                return null;
            }
        }

        static getLastUpdate() {
            return parseInt(localStorage.getItem('wayfarerexporter-lastupdate') || '0', 10);
        }

        static updateSingleCandidate(id, candidateData, isDelete = false) {
            const candidates = this.getCandidates() || {};
            if (isDelete) {
                delete candidates[id];
            } else {
                candidates[id] = candidateData;
            }
            localStorage.setItem('wayfarerexporter-candidates', JSON.stringify(candidates));
            localStorage.setItem('wayfarerexporter-lastupdate', Date.now().toString());
        }

        static saveAllCandidates(candidates) {
            localStorage.setItem('wayfarerexporter-candidates', JSON.stringify(candidates));
            localStorage.setItem('wayfarerexporter-lastupdate', Date.now().toString());
        }
    }

    /**
     * 网络拦截模块：双模拦截 fetch 和 XHR
     */
    class NetworkInterceptor {
        constructor(onDataReceived) {
            this.onDataReceived = onDataReceived;
            this.win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            this.interceptXHR();
            this.interceptFetch();
        }

        interceptXHR() {
            const originalOpen = this.win.XMLHttpRequest.prototype.open;
            const self = this;
            this.win.XMLHttpRequest.prototype.open = function (method, url) {
                if (url.includes(CONFIG.API_MANAGE) && method === 'GET') {
                    this.addEventListener('load', function() {
                        self.processResponse(this.response);
                    }, false);
                }
                return originalOpen.apply(this, arguments);
            };
        }

        interceptFetch() {
            const originalFetch = this.win.fetch;
            const self = this;
            this.win.fetch = async function (...args) {
                const response = await originalFetch.apply(this, args);
                const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;

                if (url && url.includes(CONFIG.API_MANAGE)) {
                    const clonedResponse = response.clone();
                    clonedResponse.text().then(text => self.processResponse(text));
                }
                return response;
            };
        }

        processResponse(responseText) {
            try {
                const json = JSON.parse(responseText);
                const rawSubmissions = json?.result?.submissions;
                if (rawSubmissions) {
                    const nominations = rawSubmissions.filter(n => n.type === 'NOMINATION');
                    this.onDataReceived(nominations);
                }
            } catch (e) {
                console.error('[Wayfarer Exporter] Data parsing failed:', e);
            }
        }
    }

    /**
     * 核心业务模块
     */
    class WayfarerExporter {
        constructor() {
            this.queue = [];
            this.activeUploads = 0;
            this.candidates = {};
            this.logger = new UILogger();

            this.init();
        }

        init() {
            new NetworkInterceptor((data) => this.analyzeCandidates(data));
            this.observeUI();
            this.ensureProfileName();
        }

        observeUI() {
            const observer = new MutationObserver((mutations, obs) => {
                const sidebar = document.querySelector('.sidebar-link[href$="nominations"]');
                if (sidebar) {
                    this.injectConfigButton(sidebar);
                    obs.disconnect();
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }

        async analyzeCandidates(apiNominations) {
            const storedCandidates = await this.loadOrFetchCandidates();
            if (!storedCandidates) return;

            this.candidates = storedCandidates;
            this.logger.log(`Analyzing ${apiNominations.length} nominations...`);

            const currentApiIds = new Set(apiNominations.map(n => n.id));
            let tasksAdded = false;

            for (const nomination of apiNominations) {
                if (await this.processSingleNomination(nomination, currentApiIds)) {
                    tasksAdded = true;
                }
            }

            if (!tasksAdded) {
                this.logger.log('No changes detected. System in sync.');
                setTimeout(() => this.logger.destroy(), 3000);
            }
        }

        async processSingleNomination(nomination, currentApiIds) {
            const id = nomination.id;
            const existing = this.candidates[id];
            const currentStatus = this.statusConvertor(nomination.status);

            const updatedData = {
                cell17id: S2Helper.getCellId(nomination.lat, nomination.lng),
                title: nomination.title,
                description: nomination.description,
                lat: nomination.lat,
                lng: nomination.lng,
                status: currentStatus
            };

            // 1. 已存在的记录
            if (existing) {
                if (nomination.status === 'ACCEPTED') {
                    this.logger.log(`Approved: ${nomination.title}`);
                    // 只有网络请求成功后，才从本地删除
                    this.enqueueSyncTask(nomination, 'delete', () => {
                        StorageService.updateSingleCandidate(id, null, true);
                    });
                    return true;
                }

                const isStatusChanged = currentStatus !== existing.status;
                const isInfoChanged = nomination.title !== existing.title || nomination.description !== existing.description;

                if (isStatusChanged || isInfoChanged) {
                    const changeType = isStatusChanged ? `Status (${currentStatus})` : 'Info';
                    this.logger.log(`Updating ${nomination.title}: ${changeType}`);

                    // 原子化更新：网络成功后更新本地单条记录
                    this.enqueueSyncTask(nomination, currentStatus, () => {
                        StorageService.updateSingleCandidate(id, updatedData, false);
                    });
                    return true;
                }
                return false;
            }

            // 2. 新记录
            if (['NOMINATED', 'VOTING', 'HELD', 'APPEALED', 'NIANTIC_REVIEW'].includes(nomination.status)) {
                this.handlePotentialDuplicates(nomination, updatedData.cell17id, currentApiIds);

                this.logger.log(`New Candidate: ${nomination.title}`);
                this.enqueueSyncTask(nomination, currentStatus, () => {
                    StorageService.updateSingleCandidate(id, updatedData, false);
                });
                return true;
            }
            return false;
        }

        handlePotentialDuplicates(nomination, newCell17Id, currentApiIds) {
            Object.keys(this.candidates).forEach(idx => {
                const candidate = this.candidates[idx];
                if (currentApiIds.has(idx)) return;

                if (candidate.status === 'potential' && candidate.cell17id === newCell17Id) {
                    const dist = S2Helper.getDistance(candidate, nomination);
                    const sameTitle = candidate.title === nomination.title;

                    if ((sameTitle && dist < 10) || dist < 3) {
                        this.logger.log(`Replacing manual entry: ${candidate.title}`);
                        this.enqueueSyncTask({ id: idx }, 'delete', () => {
                            StorageService.updateSingleCandidate(idx, null, true);
                        });
                    }
                }
            });
        }

        enqueueSyncTask(nomination, status, onSuccessCallback) {
            this.ensureProfileName().then(nickname => {
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

                this.queue.push({ formData, onSuccessCallback, title: nomination.title });
                this.processQueue();
            });
        }

        processQueue() {
            if (this.activeUploads >= CONFIG.MAX_CONCURRENT_UPLOADS || this.queue.length === 0) return;

            const task = this.queue.shift();
            this.activeUploads++;
            this.logger.updateQueueStatus(this.queue.length + this.activeUploads);

            const url = StorageService.getUrl();

            // 引入 AbortController 实现超时丢弃机制
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.SYNC_TIMEOUT);

            fetch(url, { method: 'POST', body: task.formData, signal: controller.signal })
            .then(res => {
                if (!res.ok) throw new Error('HTTP Error');
                // 仅在明确成功时执行状态固化
                if (task.onSuccessCallback) task.onSuccessCallback();
            })
            .catch(error => {
                task.formData.retries--;
                if (task.formData.retries > 0) {
                    this.queue.push(task);
                } else {
                    this.logger.log(`[!] Failed permanently: ${task.title || 'Task'}`);
                }
            })
            .finally(() => {
                clearTimeout(timeoutId);
                this.activeUploads--;
                this.logger.updateQueueStatus(this.queue.length + this.activeUploads);
                this.processQueue();
            });
        }

        async loadOrFetchCandidates() {
            const storedData = StorageService.getCandidates();
            const lastUpdate = StorageService.getLastUpdate();
            const now = Date.now();

            if (!storedData || (now - lastUpdate) > CONFIG.CACHE_DURATION) {
                return await this.fetchPlannerDataFromGoogle();
            }
            return storedData;
        }

        async fetchPlannerDataFromGoogle(customUrl) {
            let url = customUrl || StorageService.getUrl();
            if (!url) {
                url = window.prompt('Please enter your Google Script URL (exec version):');
                if (!url) return null;
            }

            try {
                this.logger.log('Downloading master list from spreadsheet...');
                const response = await fetch(url);
                const data = await response.json();

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

                StorageService.setUrl(url);
                StorageService.saveAllCandidates(candidates);
                this.logger.log(`Loaded ${Object.keys(candidates).length} candidates.`);
                return candidates;
            } catch (e) {
                this.logger.log('[!] Failed to connect to Google Script.');
                return null;
            }
        }

        async ensureProfileName() {
            let name = StorageService.getNickname();
            if (name) return name;

            try {
                const res = await fetch(CONFIG.API_PROFILE);
                const json = await res.json();
                name = json.result.socialProfile.name;
                StorageService.setNickname(name);
                return name;
            } catch (e) {
                return 'wayfarer_user';
            }
        }

        statusConvertor(status) {
            const map = {
                'HELD': 'held',
                'NOMINATED': 'submitted',
                'VOTING': 'voting',
                'NIANTIC_REVIEW': 'niantic_review',
                'REJECTED': 'rejected',
                'DUPLICATE': 'rejected',
                'WITHDRAWN': 'rejected',
                'APPEALED': 'appealed'
            };
            return map[status] || 'submitted';
        }

        injectConfigButton(referenceNode) {
            if (document.querySelector('.sidebar-wayfarerexporter')) return;
            const link = document.createElement('a');
            link.className = 'mat-tooltip-trigger sidebar-link sidebar-wayfarerexporter';
            link.title = 'Sync Config';
            link.innerHTML = `<svg viewBox="0 0 24 24" class="sidebar-link__icon" style="width:24px;height:24px;fill:currentColor"><path d="M12,1L8,5H11V14H13V5H16M18,23H6C4.89,23 4,22.1 4,21V9A2,2 0 0,1 6,7H9V9H6V21H18V9H15V7H18A2,2 0 0,1 20,9V21A2,2 0 0,1 18,23Z" /></svg><span> Exporter</span>`;
            referenceNode.parentNode.insertBefore(link, referenceNode.nextSibling);

            link.addEventListener('click', (e) => {
                e.preventDefault();
                const url = window.prompt('Update Script Url for Wayfarer Planner', StorageService.getUrl());
                if (url) {
                    this.fetchPlannerDataFromGoogle(url).then(c => {
                        this.candidates = c || {};
                    });
                }
            });
        }
    }

    /**
     * UI 渲染模块
     */
    class UILogger {
        constructor() {
            this.container = null;
            this.injectStyles();
        }

        build() {
            if (this.container) return;
            this.container = document.createElement('div');
            this.container.className = 'wayfarer-exporter_log';
            this.container.innerHTML = `
                <div class="we-header">
                    <h3 style="margin:0;font-size:15px;">Data Sync Log</h3>
                    <span class="we-close" style="cursor:pointer;font-weight:bold;">✕</span>
                </div>
                <div class="we-status" style="font-weight:bold;margin-bottom:8px;color:#007bff;font-size:13px;"></div>
                <div class="we-wrapper" style="max-height:200px;overflow-y:auto;font-size:12px;line-height:1.4;"></div>
            `;
            document.body.appendChild(this.container);
            this.container.querySelector('.we-close').onclick = () => this.destroy();
            this.wrapper = this.container.querySelector('.we-wrapper');
            this.statusNode = this.container.querySelector('.we-status');
        }

        log(msg) {
            this.build();
            const line = document.createElement('div');
            const time = new Date().toLocaleTimeString('en-US', { hour12: false });
            line.textContent = `[${time}] ${msg}`;
            this.wrapper.appendChild(line);
            this.wrapper.scrollTop = this.wrapper.scrollHeight;
        }

        updateQueueStatus(remainingCount) {
            if (!this.container) return;
            this.statusNode.textContent = remainingCount === 0
                ? "All synchronization tasks completed."
                : `Tasks processing... Remaining: ${remainingCount}`;
            this.statusNode.style.color = remainingCount === 0 ? '#28a745' : '#007bff';
        }

        destroy() {
            if (this.container) {
                this.container.remove();
                this.container = null;
            }
        }

        injectStyles() {
            if (document.getElementById('we-styles')) return;
            const style = document.createElement('style');
            style.id = 'we-styles';
            style.textContent = `
                .wayfarer-exporter_log { position: fixed; top: 15px; right: 15px; z-index: 99999; background: rgba(255,255,255,0.95); padding: 12px; border-radius: 6px; box-shadow: 0 4px 15px rgba(0,0,0,0.15); width: 320px; font-family: system-ui, sans-serif; color: #333; backdrop-filter: blur(4px); border: 1px solid #eaeaea; }
                .we-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #ddd; padding-bottom: 8px; margin-bottom: 8px; }
                .we-wrapper::-webkit-scrollbar { width: 6px; }
                .we-wrapper::-webkit-scrollbar-thumb { background: #ccc; border-radius: 3px; }
            `;
            document.head.appendChild(style);
        }
    }

    /**
     * 几何计算模块
     */
    const S2Helper = {
        getCellId: function(lat, lng, level = 17) {
            const d2r = Math.PI / 180.0;
            const phi = lat * d2r, theta = lng * d2r, cosphi = Math.cos(phi);
            const xyz = [Math.cos(theta) * cosphi, Math.sin(theta) * cosphi, Math.sin(phi)];

            let face = 0;
            const absXYZ = [Math.abs(xyz[0]), Math.abs(xyz[1]), Math.abs(xyz[2])];
            if (absXYZ[0] > absXYZ[1]) face = absXYZ[0] > absXYZ[2] ? 0 : 2;
            else face = absXYZ[1] > absXYZ[2] ? 1 : 2;
            if (xyz[face] < 0) face += 3;

            let u, v;
            switch (face) {
                case 0: u = xyz[1]/xyz[0]; v = xyz[2]/xyz[0]; break;
                case 1: u = -xyz[0]/xyz[1]; v = xyz[2]/xyz[1]; break;
                case 2: u = -xyz[0]/xyz[2]; v = -xyz[1]/xyz[2]; break;
                case 3: u = xyz[2]/xyz[0]; v = xyz[1]/xyz[0]; break;
                case 4: u = xyz[2]/xyz[1]; v = -xyz[0]/xyz[1]; break;
                case 5: u = -xyz[1]/xyz[2]; v = -xyz[0]/xyz[2]; break;
            }

            const uvToST = val => val >= 0 ? 0.5 * Math.sqrt(1 + 3 * val) : 1 - 0.5 * Math.sqrt(1 - 3 * val);
            const stToIJ = st => Math.max(0, Math.min((1 << level) - 1, Math.floor(st * (1 << level))));

            const ij = [stToIJ(uvToST(u)), stToIJ(uvToST(v))];
            return `F${face}ij[${ij[0]},${ij[1]}]@${level}`;
        },
        getDistance: function(p1, p2) {
            const dLat = (p2.lat - p1.lat) * Math.PI / 180;
            const dLong = (p2.lng - p1.lng) * Math.PI / 180;
            const a = Math.sin(dLat / 2) ** 2 + Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.sin(dLong / 2) ** 2;
            return 6378137 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        }
    };

    // 实例化启动
    new WayfarerExporter();
})();
