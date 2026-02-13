// ==UserScript==
// @name         Wayfarer Exporter Optimized
// @version      0.9.1
// @description  Export nominations data from Wayfarer to IITC via Google Sheets
// @namespace    https://github.com/Editst/wayfarer/
// @downloadURL  https://github.com/Editst/wayfarer/raw/main/wayfarer-exporter.user.js
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
        MAX_CONCURRENT_UPLOADS: 3, // 限制并发数，防止 Google Script 报错
        CACHE_DURATION: 12 * 60 * 60 * 1000, // 本地缓存有效期 12小时
        RETRY_LIMIT: 3
    };

    class WayfarerExporter {
        constructor() {
            this.queue = []; // 发送队列
            this.activeUploads = 0;
            this.candidates = {}; // 本地缓存的候选列表
            this.sentNominations = null; // 当前页面获取的列表
            this.profileName = null;
            this.logger = null;
            
            this.init();
        }

        init() {
            this.interceptXHR();
            this.observeUI();
            this.loadProfileName(); // 预加载用户名
        }

        /**
         * 劫持 XHR 以获取 Wayfarer API 数据
         * 使用 unsafeWindow 确保能拦截到页面原生的请求
         */
        interceptXHR() {
            const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const originalOpen = win.XMLHttpRequest.prototype.open;
            const self = this;

            win.XMLHttpRequest.prototype.open = function (method, url) {
                // 监听列表获取接口
                if (url.includes('/api/v1/vault/manage') && method === 'GET') {
                    this.addEventListener('load', (e) => self.handleNominationsLoad(e), false);
                }
                // 监听用户信息接口（备用）
                if (url.includes('/api/v1/vault/properties') && method === 'GET') {
                    this.addEventListener('load', (e) => self.handleProfileLoad(e), false);
                }
                return originalOpen.apply(this, arguments);
            };
        }

        /**
         * 使用 MutationObserver 监听侧边栏加载，替代 setTimeout 轮询
         */
        observeUI() {
            const observer = new MutationObserver((mutations, obs) => {
                const sidebar = document.querySelector('.sidebar-link[href$="nominations"]');
                if (sidebar) {
                    this.addConfigurationButton(sidebar);
                    obs.disconnect(); // 找到后停止监听
                }
            });

            observer.observe(document.documentElement, {
                childList: true,
                subtree: true
            });
        }

        /**
         * 处理 API 返回的申请列表数据
         */
        handleNominationsLoad(event) {
            try {
                const response = event.target.response;
                const json = JSON.parse(response);
                this.sentNominations = json?.result?.submissions;

                if (!this.sentNominations) {
                    this.log('Error: Failed to parse nominations data.');
                    return;
                }
                
                // 稍作延迟以确保 UI 渲染完成
                setTimeout(() => this.analyzeCandidates(), 500);

            } catch (e) {
                console.error('[Wayfarer Exporter] JSON Parse Error:', e);
            }
        }

        handleProfileLoad(event) {
            try {
                const json = JSON.parse(event.target.response);
                const name = json?.result?.socialProfile?.name;
                if (name) {
                    this.profileName = name;
                    localStorage.setItem('wayfarerexporter-nickname', name);
                }
            } catch(e) {}
        }

        /**
         * 核心逻辑：分析候选差异
         */
        async analyzeCandidates() {
            if (!this.sentNominations) return;

            const storedCandidates = await this.getAllCandidates();
            if (!storedCandidates) return;

            this.candidates = storedCandidates;
            this.log(`Analyzing ${this.sentNominations.length} nominations...`);

            // [Fix] 创建一个包含当前 API 所有 ID 的 Set，用于防止误删真实存在的近距离申请
            const currentApiIds = new Set(this.sentNominations.map(n => n.id));

            let modified = false;
            
            // 遍历当前 API 返回的所有申请
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

        /**
         * 检查单个申请的状态变化
         * @returns {boolean} 是否发生了变化
         */
        async checkNomination(nomination, currentApiIds) {
            const id = nomination.id;
            const existing = this.candidates[id];
            const currentStatus = this.statusConvertor(nomination.status);

            // 1. 已存在的记录
            if (existing) {
                // 如果已通过，不再追踪，发送删除指令给 Sheet
                if (nomination.status === 'ACCEPTED') {
                    this.log(`Approved: ${nomination.title}`);
                    this.queueUpdate(nomination, 'delete'); 
                    delete this.candidates[id];
                    return true;
                }

                // 状态变更检测 (held <-> nominated <-> voting)
                if (currentStatus !== existing.status) {
                    this.candidates[id].status = currentStatus;
                    this.queueUpdate(nomination, currentStatus);
                    this.log(`Status Changed: ${nomination.title} -> ${currentStatus}`);
                    return true;
                }

                // 信息变更检测
                if (nomination.title !== existing.title || nomination.description !== existing.description) {
                    this.candidates[id].title = nomination.title;
                    this.candidates[id].description = nomination.description;
                    this.queueUpdate(nomination, currentStatus);
                    this.log(`Info Updated: ${nomination.title}`);
                    return true;
                }
                
                return false;
            }

            // 2. 新记录 (Nominated/Voting/Held/Appealed)
            if (['NOMINATED', 'VOTING', 'HELD', 'APPEALED'].includes(nomination.status)) {
                // S2 查重逻辑：检查是否已经在 IITC 中手动添加过
                const cell17id = S2Helper.getCellId(nomination.lat, nomination.lng);
                
                Object.keys(this.candidates).forEach(idx => {
                    const candidate = this.candidates[idx];
                    
                    // [Fix] 如果本地缓存的这个 candidate 其实也在当前的 API 列表中，
                    // 说明它是另一个真实的申请，不是手动添加的占位符，跳过删除逻辑。
                    if (currentApiIds.has(idx)) {
                        return; 
                    }

                    // 同一 S2 L17 格子且距离小于 20米，且确认不是真实存在的其他申请，才视为手动条目进行替换
                    if (candidate.cell17id === cell17id && S2Helper.getDistance(candidate, nomination) < 20) {
                        this.log(`Found manual entry match for ${candidate.title}, replacing.`);
                        this.queueUpdate({id: idx}, 'delete'); // 删除旧的手动条目
                        delete this.candidates[idx];
                    }
                });

                // 添加新记录
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

        /**
         * 将更新任务加入队列
         */
        queueUpdate(nomination, status) {
            this.getProfileName().then(nickname => {
                const formData = new FormData();
                formData.retries = CONFIG.RETRY_LIMIT;
                formData.append('status', status);
                formData.append('id', nomination.id);
                // 仅在非删除操作时附加详细信息
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

        /**
         * 处理发送队列
         */
        processQueue() {
            if (this.activeUploads >= CONFIG.MAX_CONCURRENT_UPLOADS || this.queue.length === 0) {
                return;
            }

            const formData = this.queue.shift();
            this.activeUploads++;
            this.updateLogUI();

            const url = localStorage['wayfarerexporter-url'];
            if (!url) {
                console.error('Script URL not found');
                this.activeUploads--;
                return;
            }

            fetch(url, {
                method: 'POST',
                body: formData
            })
            .then(() => {
                // Success
            })
            .catch(error => {
                console.error('Upload failed', error);
                formData.retries--;
                if (formData.retries > 0) {
                    this.queue.push(formData); // 重新入队
                } else {
                    this.log(`Failed to sync: ${formData.get('title')}`);
                }
            })
            .finally(() => {
                this.activeUploads--;
                this.updateLogUI();
                this.processQueue(); // 尝试处理下一个
            });
        }

        /**
         * 获取本地缓存的所有候选
         */
        async getAllCandidates() {
            const storedData = localStorage['wayfarerexporter-candidates'];
            const lastUpdate = localStorage['wayfarerexporter-lastupdate'] || 0;
            const now = Date.now();

            // 如果缓存过期或不存在，从 Sheet 重新加载
            if (!storedData || (now - lastUpdate) > CONFIG.CACHE_DURATION) {
                return await this.loadPlannerData();
            }
            return JSON.parse(storedData);
        }

        /**
         * 从 Google Sheet 获取初始数据
         */
        async loadPlannerData(customUrl) {
            let url = customUrl || localStorage['wayfarerexporter-url'];
            if (!url) {
                url = window.prompt('Please enter your Google Script URL for Wayfarer Planner:');
                if (!url) return null;
            }

            // 基础 URL 校验
            if (!url.startsWith('https://script.google.com/macros/') || !url.endsWith('exec')) {
                alert('Invalid URL. It must be the "exec" URL from Google App Script.');
                return null;
            }

            try {
                this.log('Loading data from spreadsheet...');
                const response = await fetch(url);
                const data = await response.json();

                // 过滤相关状态
                const activeStatus = ['submitted', 'potential', 'held', 'rejected', 'appealed'];
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

                // 更新本地存储
                localStorage['wayfarerexporter-url'] = url;
                localStorage['wayfarerexporter-lastupdate'] = Date.now();
                localStorage['wayfarerexporter-candidates'] = JSON.stringify(candidates);
                
                this.log(`Loaded ${Object.keys(candidates).length} active candidates.`);
                return candidates;

            } catch (e) {
                this.log('Failed to load data from spreadsheet.');
                console.error(e);
                alert('Connection to Google Script failed. Check console for details.');
                return null;
            }
        }

        saveLocalCandidates() {
            localStorage['wayfarerexporter-candidates'] = JSON.stringify(this.candidates);
        }

        /**
         * 获取用户名（优先缓存）
         */
        async getProfileName() {
            if (this.profileName) return this.profileName;
            
            const cached = localStorage.getItem('wayfarerexporter-nickname');
            if (cached) {
                this.profileName = cached;
                return cached;
            }

            try {
                const res = await fetch('https://opr.ingress.com/api/v1/vault/properties');
                const json = await res.json();
                this.profileName = json.result.socialProfile.name;
                localStorage.setItem('wayfarerexporter-nickname', this.profileName);
                return this.profileName;
            } catch (e) {
                return 'wayfarer_user';
            }
        }
        
        loadProfileName() {
             this.getProfileName();
        }

        statusConvertor(status) {
            const map = {
                'HELD': 'held',
                'NOMINATED': 'submitted',
                'VOTING': 'submitted',
                'REJECTED': 'rejected',
                'DUPLICATE': 'rejected',
                'WITHDRAWN': 'rejected',
                'APPEALED': 'appealed'
            };
            return map[status] || status;
        }

        // --- UI 相关方法 ---

        addConfigurationButton(referenceNode) {
            if (document.querySelector('.sidebar-wayfarerexporter')) return;

            this.injectStyles();

            const link = document.createElement('a');
            link.className = 'mat-tooltip-trigger sidebar-link sidebar-wayfarerexporter';
            link.title = 'Sync to IITC';
            link.innerHTML = `
                <svg viewBox="0 0 24 24" class="sidebar-link__icon" style="width:24px;height:24px;fill:currentColor">
                    <path d="M12,1L8,5H11V14H13V5H16M18,23H6C4.89,23 4,22.1 4,21V9A2,2 0 0,1 6,7H9V9H6V21H18V9H15V7H18A2,2 0 0,1 20,9V21A2,2 0 0,1 18,23Z" />
                </svg>
                <span> Exporter</span>
            `;

            // 插入到 Nominations 链接之后
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
            if (!this.logger) {
                this.createLogger();
            }
            const line = document.createElement('div');
            line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
            this.msgLog.appendChild(line);
            this.msgLog.scrollTop = this.msgLog.scrollHeight;
        }
        
        updateLogUI() {
             if(this.statusLog) {
                 const remaining = this.queue.length + this.activeUploads;
                 if(remaining === 0) this.statusLog.textContent = "All synced.";
                 else this.statusLog.textContent = `Syncing... Remaining: ${remaining}`;
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
            style.textContent = `
                .wayfarer-exporter_log {
                    position: fixed; top: 10px; right: 10px; z-index: 9999;
                    background: white; padding: 10px; border-radius: 4px;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.2); width: 300px;
                    font-family: sans-serif; color: #333;
                }
            `;
            document.head.appendChild(style);
        }
    }

    /**
     * S2 Geometry Helper (Simplified for L17 Cell ID only)
     * 纯净的 S2 计算逻辑，用于计算 Cell ID 和距离
     */
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
            const R = 6378137; // 地球平均半径 (米)
            const dLat = (p2.lat - p1.lat) * Math.PI / 180;
            const dLong = (p2.lng - p1.lng) * Math.PI / 180;
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                      Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
                      Math.sin(dLong / 2) * Math.sin(dLong / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        }
    };

    // 启动脚本
    new WayfarerExporter();

})();
