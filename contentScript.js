(() => {
    // Use browser namespace for Firefox compatibility
    const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
    
    let youtubePlayer;
    let currentVideo = "";
    let commentCache = [];
    let displayedComments = new Set();
    let isLoading = false;
    let isPaused = false;
    let commentCheckInterval;
    let isCommentsEnabled = true; // Default to true
    let hasInitialized = false;
    let commentContainer;

    const CancelReason = {
        None: 'None',
        CancelButtonClicked: 'CancelButtonClicked',
        MaxCommentCacheLimit: 'MaxCommentCacheLimit',
        isCommentsDisabled: 'isCommentsDisabled'
    };

    // Default settings
    let COMMENT_DISPLAY_DURATION = 4000;  // 4 seconds
    let MAX_COMMENT_CACHE = 0;

    // Retrieve settings from storage
    browserAPI.storage.local.get(['commentDuration', 'maxCommentCache', 'commentsEnabled'], (result) => {
        COMMENT_DISPLAY_DURATION = (result.commentDuration || 4) * 1000;
        MAX_COMMENT_CACHE = result.maxCommentCache || 0;
        isCommentsEnabled = result.commentsEnabled !== undefined ? result.commentsEnabled : true;
    });

    // Regex patterns for filtering
    const INVALID_COMMENT_PATTERNS = [
        /\d{1,2}:\d{2}\s*p\.?m\.?/i,  // Exclude time with PM
        (text) => {
            // Strip HTML tags and then check for 'exam'
            const strippedText = text.replace(/<\/?[^>]+(>|$)/g, '');
            return /(exam)/i.test(strippedText);
        },
        (text) => {
            // Strip HTML tags and then check for 'god'
            const strippedText = text.replace(/<\/?[^>]+(>|$)/g, '');
            return /\b(god)\b/i.test(strippedText);
        }
    ];

    // Regex for extracting timestamps
    const TIMESTAMP_REGEX = /(?:\d+:)?[0-5]?\d:[0-5]\d/g;

    // Clean and validate comment text
    const cleanCommentText = (text) => {
        // First normalize all line breaks to \n
        let cleaned = text.replace(/<br\s*\/?>/gi, '\n')
                         .replace(/\r\n/g, '\n')
                         .replace(/\r/g, '\n');
        
        // Replace 3 or more consecutive newlines with 2 newlines
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        
        // Convert back to <br> tags for HTML display
        cleaned = cleaned.replace(/\n/g, '<br>');
        
        return cleaned.trim();
    };

    // Check if text is only timestamps
    const isTimestampOnly = (text) => {
        // Remove HTML tags
        text = text.replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
        // Remove all timestamps from text
        const textWithoutTimestamps = text.replace(/(?:\d+:)?[0-5]?\d:[0-5]\d/g, '');
        // Remove common separators
        const cleanedText = textWithoutTimestamps.replace(/[,.\s\-|+]/g, '');
        // If nothing meaningful remains, it was only timestamps
        return cleanedText.length === 0;
    };

    // Store user's channel ID locally
    let userChannelId = null;

    // Function to check if extension context is valid
    const isExtensionContextValid = () => {
        try {
            return browserAPI && browserAPI.runtime && browserAPI.runtime.id;
        } catch (error) {
            return false;
        }
    };
    // Function to get user's channel ID from OAuth key
    const getUserChannelId = async () => {
        // Check extension context before accessing storage
        if (!isExtensionContextValid()) {
            console.warn("Extension context invalidated, cannot retrieve OAuth key");
            return null;
        }
        
        // Get OAuth key from background script
        const token = await new Promise((resolve) => {
            browserAPI.runtime.sendMessage({ type: "GET_OAUTH_KEY" }, (response) => {
                if (response.success) {
                    resolve(response.oauthKey);
                } else {
                    console.error('Failed to get OAuth key:', response.error);
                    resolve(null);
                }
            });
        });
        
        if (!token) return null;
        
        try {
            const response = await fetch(
                'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            if (!response.ok) {
                console.error('Failed to get user channel:', await response.text());
                return null;
            }
            
            const data = await response.json();
            if (data.items && data.items.length > 0) {
                const channelId = data.items[0].id;
                // Store in local variable instead of Chrome storage
                userChannelId = channelId;
                return channelId;
            }
            
            return null;
        } catch (error) {
            console.error('Error getting user channel:', error);
            return null;
        }
    };

    // Process comments to extract timestamps and filter invalid ones
    const processComments = (comments) => {
        const processedComments = [];
        const seen = new Set();

        comments.forEach(comment => {
            const text = cleanCommentText(comment.textDisplay);
            
            // Skip if comment contains invalid patterns
            for (const pattern of INVALID_COMMENT_PATTERNS) {
                if (typeof pattern === 'function') {
                    if (pattern(text)) {
                        return;
                    }
                } else if (pattern.test(text)) {
                    return;
                }
            }

            // Skip if comment is only timestamps
            if (isTimestampOnly(text)) {
                return;
            }

            // Extract timestamps
            const timestamps = text.match(TIMESTAMP_REGEX) || [];
            if (timestamps.length === 0) {
                return;
            }

            // Convert earliest timestamp to seconds for sorting
            const earliestTimestamp = timestamps.reduce((earliest, current) => {
                const earliestParts = earliest.split(':').map(Number);
                const currentParts = current.split(':').map(Number);
                
                // Normalize to seconds based on number of parts
                const earliestSeconds = earliestParts.length === 3 
                    ? earliestParts[0] * 3600 + earliestParts[1] * 60 + earliestParts[2]
                    : earliestParts[0] * 60 + earliestParts[1];
                
                const currentSeconds = currentParts.length === 3
                    ? currentParts[0] * 3600 + currentParts[1] * 60 + currentParts[2]
                    : currentParts[0] * 60 + currentParts[1];
                
                return currentSeconds < earliestSeconds 
                    ? current 
                    : earliest;
            });

            const key = `${earliestTimestamp}-${text}`;
            if (!seen.has(key)) {
                seen.add(key);
                processedComments.push({
                    ...comment,
                    timestamp: earliestTimestamp,
                    timestampSeconds: timestampToSeconds(earliestTimestamp)
                });
            }
        });

        return processedComments.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
    };

    // Function to find the YouTube player
    const findYouTubePlayer = () => {
        // Try multiple selectors to find the player
        const playerSelectors = [
            '#movie_player video', 
            'video.html5-main-video', 
            'ytd-player video'
        ];

        for (const selector of playerSelectors) {
            const player = document.querySelector(selector);
            if (player) return player;
        }
        return null;
    };

    // Initialize YouTube player and video controls
    const setupVideoControls = () => {
        youtubePlayer = findYouTubePlayer();
        
        if (!youtubePlayer) {
            // Retry finding player after a short delay
            setTimeout(setupVideoControls, 1000);
            return;
        }

        // Add event listeners for play/pause
        youtubePlayer.addEventListener('play', () => {
            isPaused = false;
        });

        youtubePlayer.addEventListener('pause', () => {
            isPaused = true;
        });
    };

    // Initialize on page load
    const initializeExtension = () => {
        // Get video ID from URL
        const urlParams = new URLSearchParams(window.location.search);
        const videoId = urlParams.get('v');
        
        if (videoId && videoId !== currentVideo) {
            currentVideo = videoId;
            newVideoLoaded();
            setupVideoControls();
            hasInitialized = true;
        }
    };

    // Listen for URL changes
    const checkForUrlChanges = () => {
        const urlParams = new URLSearchParams(window.location.search);
        const videoId = urlParams.get('v');
        
        if (videoId && videoId !== currentVideo) {
            currentVideo = videoId;
            newVideoLoaded();
            setupVideoControls();
            hasInitialized = true;
        } else if (!videoId && currentVideo) {
            // Reset when navigating away from video (e.g., back to homepage)
            currentVideo = "";
            hasInitialized = false;
            if (commentCheckInterval) {
                clearInterval(commentCheckInterval);
                commentCheckInterval = null;
            }
        }
    };

    // Call initialize on page load
    if (document.readyState === 'complete') {
        initializeExtension();
    } else {
        window.addEventListener('load', initializeExtension);
    }

    // Watch for navigation events
    const observer = new MutationObserver(() => {
        // Only check for URL changes if we're on a YouTube page that could have videos
        if (window.location.href.includes('youtube.com')) {
            checkForUrlChanges();
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    // Listen for messages from background script and popup
    browserAPI.runtime.onMessage.addListener((obj, sender, response) => {
        const { type, videoId, enabled, settings } = obj;
        
        if (type === "NEW") {
            if (!hasInitialized) {
                currentVideo = videoId;
                newVideoLoaded();
                setupVideoControls();
                hasInitialized = true;
            }
        } else if (type === "TOGGLE_COMMENTS") {
            isCommentsEnabled = enabled;
            toggleCommentsVisibility(enabled);
        } else if (type === "SETTINGS_UPDATED" && settings) {
            COMMENT_DISPLAY_DURATION = (settings.commentDuration || 4) * 1000;
            MAX_COMMENT_CACHE = settings.maxCommentCache || 0;
        }
        return true; // Required for Firefox async response
    });

    // Function to toggle comments visibility
    const toggleCommentsVisibility = (show) => {
        if (commentContainer) {
            commentContainer.style.display = show ? 'block' : 'none';
        }
    };

    const createCommentContainer = () => {
        const container = document.createElement("div");
        container.className = "yt-timestamped-comments-container";
        container.style.cssText = `
            position: absolute;
            top: 60px;
            left: 10px;
            z-index: 1000;
            max-width: 400px;
            max-height: 500px;
            overflow-y: auto;
            overscroll-behavior: contain;
        `;

        return container;
    };

    const formatDate = (dateString) => {
        const date = new Date(dateString);
        const now = new Date();
        const diffTime = Math.abs(now - date);
        
        const diffSeconds = Math.floor(diffTime / 1000);
        const diffMinutes = Math.floor(diffTime / (1000 * 60));
        const diffHours = Math.floor(diffTime / (1000 * 60 * 60));
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        const diffMonths = Math.floor(diffDays / 30);
        const diffYears = Math.floor(diffDays / 365);

        let timeAgo;
        if (diffYears > 0) {
            timeAgo = `${diffYears} ${diffYears === 1 ? 'year' : 'years'} ago`;
        } else if (diffMonths > 0) {
            timeAgo = `${diffMonths} ${diffMonths === 1 ? 'month' : 'months'} ago`;
        } else if (diffDays > 0) {
            timeAgo = `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`;
        } else if (diffHours > 0) {
            timeAgo = `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
        } else if (diffMinutes > 0) {
            timeAgo = `${diffMinutes} ${diffMinutes === 1 ? 'minute' : 'minutes'} ago`;
        } else if (diffSeconds > 0) {
            timeAgo = `${diffSeconds} ${diffSeconds === 1 ? 'second' : 'seconds'} ago`;
        } else {
            timeAgo = 'just now';
        }

        // Format exact timestamp for tooltip
        const exactTimestamp = date.toLocaleString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZoneName: 'short'
        });

        // Format exact date (e.g., 15-Mar-2025)
        const exactDate = date.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
        });

        return {
            exactDate: exactDate,
            timeAgo: timeAgo,
            tooltip: exactTimestamp
        };
    };

    const createReplyElement = (reply, repliesContainer, comment = null, commentId = null) => {
        const replyEl = document.createElement("div");
        replyEl.className = "yt-timestamped-comment-reply";
        replyEl.style.cssText = `
            display: flex;
            gap: 8px;
            margin-top: 8px;
            padding-left: 10px;
        `;
        
        const replyContent = document.createElement("div");
        replyContent.style.flexGrow = "1";
        const formattedReplyDate = formatDate(reply.publishedAt);
        replyContent.innerHTML = `
            <div style="font-weight: bold">${reply.authorDisplayName}</div>
            <div>${cleanCommentText(reply.textDisplay)}</div>
            <div style="font-size: 0.8em; color: #aaa">${reply.likeCount} likes · <span title="${formattedReplyDate.tooltip}" style="cursor: help; border-bottom: 1px dotted rgba(255, 255, 255, 0.3);">${formattedReplyDate.timeAgo}</span></div>
        `;
        
        const channelId = reply.authorChannelId.value || reply.authorChannelId;
        // Check if this is user's own reply and add edit/remove buttons
        if (userChannelId === channelId) {
            // Add edit/remove buttons for user's own replies only
            const replyActions = document.createElement("div");
            replyActions.style.cssText = `
                display: flex;
                gap: 4px;
                margin-top: 4px;
            `;
            
            const editButton = document.createElement("button");
            editButton.textContent = "✏️ Edit";
            editButton.style.cssText = `
                background: rgba(255, 193, 7, 0.8);
                color: #333;
                border: 1px solid rgba(255, 193, 7, 0.3);
                padding: 2px 6px;
                border-radius: 3px;
                cursor: pointer;
                font-size: 10px;
                transition: all 0.2s ease;
            `;
            
            const removeButton = document.createElement("button");
            removeButton.textContent = "🗑️";
            removeButton.style.cssText = `
                background: rgba(220, 53, 69, 0.8);
                color: white;
                border: 1px solid rgba(220, 53, 69, 0.3);
                padding: 2px 6px;
                border-radius: 3px;
                cursor: pointer;
                font-size: 10px;
                transition: all 0.2s ease;
            `;
            
            // Add hover effects for edit/delete buttons
            editButton.addEventListener("mouseenter", () => {
                editButton.style.background = "rgba(255, 193, 7, 1)";
                editButton.style.transform = "scale(1.05)";
            });
            editButton.addEventListener("mouseleave", () => {
                editButton.style.background = "rgba(255, 193, 7, 0.8)";
                editButton.style.transform = "scale(1)";
            });
            
            removeButton.addEventListener("mouseenter", () => {
                removeButton.style.background = "rgba(220, 53, 69, 1)";
                removeButton.style.transform = "scale(1.05)";
            });
            removeButton.addEventListener("mouseleave", () => {
                removeButton.style.background = "rgba(220, 53, 69, 0.8)";
                removeButton.style.transform = "scale(1)";
            });
            
            editButton.addEventListener("click", () => {
                // Close any existing reply or edit interfaces
                const existingReplyInterface = document.querySelector('[data-reply-interface]');
                const existingEditInterface = document.querySelector('[data-edit-interface]');
                
                if (existingEditInterface) {
                    existingEditInterface.remove();
                    return; // Don't open new one if we just closed one
                }
                if (existingReplyInterface) {
                    existingReplyInterface.remove();
                }
                
                // Create edit interface as absolute positioned overlay
                const editInterface = document.createElement("div");
                editInterface.setAttribute('data-edit-interface', 'true');
                editInterface.style.cssText = `
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%) scale(0.9);
                    opacity: 0;
                    z-index: 999999;
                    background: rgba(28, 28, 28, 0.95);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 8px;
                    padding: 16px;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                    backdrop-filter: blur(10px);
                    min-width: 400px;
                    max-width: 600px;
                    transition: all 0.2s ease;
                `;
                
                const editInput = document.createElement("textarea");
                editInput.style.cssText = `
                    width: 100%;
                    height: 80px;
                    padding: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.3);
                    border-radius: 4px;
                    resize: none;
                    font-family: Arial, sans-serif;
                    font-size: 14px;
                    background: rgba(255, 255, 255, 0.1);
                    color: white;
                    margin-bottom: 12px;
                    transition: border-color 0.2s ease;
                    box-sizing: border-box;
                `;
                
                // Create a temporary element to decode HTML entities while preserving line breaks
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = reply.textDisplay.replace(/<br\s*\/?>/gi, '\n');
                const decodedText = tempDiv.textContent || tempDiv.innerText || '';
                editInput.value = decodedText;
                tempDiv.remove();
                
                // Add escape key handler
                editInput.addEventListener("keydown", (e) => {
                    // Ctrl + Enter to send the edit
                    if (e.ctrlKey && e.key === 'Enter') {
                        e.preventDefault();
                        const text = editInput.value.trim();
                        if (text) {
                            saveButton.click();
                        }
                    }
                    // Escape to cancel
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelButton.click();
                    }
                });
                
                // Add focus effect for input
                editInput.addEventListener("focus", () => {
                    editInput.style.borderColor = "rgba(255, 255, 255, 0.6)";
                });
                editInput.addEventListener("blur", () => {
                    editInput.style.borderColor = "rgba(255, 255, 255, 0.3)";
                });
                
                const editActions = document.createElement("div");
                editActions.style.cssText = `
                    display: flex;
                    gap: 8px;
                    justify-content: flex-end;
                `;
                
                const saveButton = document.createElement("button");
                saveButton.textContent = "Save";
                saveButton.style.cssText = `
                    background: rgba(40, 167, 69, 0.8);
                    color: white;
                    border: 1px solid rgba(40, 167, 69, 0.3);
                    padding: 8px 16px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    transition: all 0.2s ease;
                `;
                
                const cancelButton = document.createElement("button");
                cancelButton.textContent = "Cancel";
                cancelButton.style.cssText = `
                    background: rgba(108, 117, 125, 0.8);
                    color: white;
                    border: 1px solid rgba(108, 117, 125, 0.3);
                    padding: 8px 16px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    transition: all 0.2s ease;
                `;
                
                // Add hover effects for save/cancel buttons
                saveButton.addEventListener("mouseenter", () => {
                    saveButton.style.background = "rgba(40, 167, 69, 1)";
                    saveButton.style.transform = "scale(1.05)";
                });
                saveButton.addEventListener("mouseleave", () => {
                    saveButton.style.background = "rgba(40, 167, 69, 0.8)";
                    saveButton.style.transform = "scale(1)";
                });
                
                cancelButton.addEventListener("mouseenter", () => {
                    cancelButton.style.background = "rgba(108, 117, 125, 1)";
                    cancelButton.style.transform = "scale(1.05)";
                });
                cancelButton.addEventListener("mouseleave", () => {
                    cancelButton.style.background = "rgba(108, 117, 125, 0.8)";
                    cancelButton.style.transform = "scale(1)";
                });
                
                saveButton.addEventListener("click", async () => {
                    const newText = editInput.value.trim();
                    if (newText && newText !== reply.textDisplay) {
                        try {
                            // Check extension context before making APP call
                            if (!isExtensionContextValid()) {
                                throw new Error("Extension context invalidated. Please refresh the page and try again.");
                            }
                            
                            const response = await browserAPI.runtime.sendMessage({
                                type: "EDIT_COMMENT",
                                commentId: commentId || reply.id,
                                newText: newText
                            });
                            
                            if (response.success) {
                                // Update the display
                                replyContent.querySelector("div:nth-child(2)").innerHTML = cleanCommentText(response.data.snippet.textDisplay);
                                reply.textDisplay = response.data.snippet.textDisplay;
                                editInterface.remove();
                            } else {
                                throw new Error(response.error);
                            }
                        } catch (error) {
                            console.error("Failed to edit reply:", error);
                            editInput.style.borderColor = "rgba(220, 53, 69, 0.8)";
                            setTimeout(() => {
                                editInput.style.borderColor = "rgba(255, 255, 255, 0.3)";
                            }, 2000);
                        }
                    } else {
                        editInterface.remove();
                    }
                });
                
                cancelButton.addEventListener("click", () => {
                    editInterface.remove();
                });
                
                editActions.appendChild(saveButton);
                editActions.appendChild(cancelButton);
                
                editInterface.appendChild(editInput);
                editInterface.appendChild(editActions);
                
                // Append to document body and animate in
                document.body.appendChild(editInterface);
                
                // Animate in
                requestAnimationFrame(() => {
                    editInterface.style.transform = "translate(-50%, -50%) scale(1)";
                    editInterface.style.opacity = "1";
                });
                
                // Auto-focus the edit input
                editInput.focus();
            });
            
            let confirmDialog = null;
            removeButton.addEventListener("click", async () => {
                // Query timestamp-delete-confirm
                if (confirmDialog) {
                    confirmDialog.remove();
                    confirmDialog = null;
                }

                // Create built-in confirmation dialog positioned next to delete button
                const buttonRect = removeButton.getBoundingClientRect();
                confirmDialog = document.createElement("div");
                confirmDialog.className = "timestamp-delete-confirm";
                confirmDialog.style.cssText = `
                    position: fixed;
                    top: ${buttonRect.bottom + 5}px;
                    left: ${buttonRect.left + 10}px;
                    background: rgba(28, 28, 28, 0.95);
                    color: white;
                    padding: 16px;
                    border-radius: 8px;
                    z-index: 999999;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                    backdrop-filter: blur(10px);
                    min-width: 250px;
                    text-align: center;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    transform: translate(-50%, -50%) scale(0.9);
                    opacity: 0;
                    transition: all 0.2s ease;
                `;
                
                confirmDialog.innerHTML = `
                    <div style="margin-bottom: 12px; font-size:14px;">Delete this reply?</div>
                    <div style="display: flex; gap: 8px; justify-content: center;">
                        <button id="confirm-delete" style="
                            background: rgba(220, 53, 69, 0.8);
                            color: white;
                            border: 1px solid rgba(220, 53, 69, 0.3);
                            padding: 8px 16px;
                            border-radius: 4px;
                            cursor: pointer;
                            font-size: 12px;
                            transition: all 0.2s ease;
                        ">Delete</button>
                        <button id="cancel-delete" style="
                            background: rgba(108, 117, 125, 0.8);
                            color: white;
                            border: 1px solid rgba(108, 117, 125, 0.3);
                            padding: 8px 16px;
                            border-radius: 4px;
                            cursor: pointer;
                            font-size: 12px;
                            transition: all 0.2s ease;
                        ">Cancel</button>
                    </div>
                `;
                
                document.body.appendChild(confirmDialog);
                
                // Animate in
                requestAnimationFrame(() => {
                    confirmDialog.style.transform = "translate(-50%, -50%) scale(1)";
                    confirmDialog.style.opacity = "1";
                });
                
                const confirmBtn = document.getElementById('confirm-delete');
                const cancelBtn = document.getElementById('cancel-delete');
                
                // Add hover effects for dialog buttons
                confirmBtn.addEventListener('mouseenter', () => {
                    confirmBtn.style.background = "rgba(220, 53, 69, 1)";
                    confirmBtn.style.transform = "scale(1.05)";
                });
                confirmBtn.addEventListener('mouseleave', () => {
                    confirmBtn.style.background = "rgba(220, 53, 69, 0.8)";
                    confirmBtn.style.transform = "scale(1)";
                });
                
                cancelBtn.addEventListener('mouseenter', () => {
                    cancelBtn.style.background = "rgba(108, 117, 125, 1)";
                    cancelBtn.style.transform = "scale(1.05)";
                });
                cancelBtn.addEventListener('mouseleave', () => {
                    cancelBtn.style.background = "rgba(108, 117, 125, 0.8)";
                    cancelBtn.style.transform = "scale(1)";
                });
                
                confirmBtn.addEventListener('click', async () => {
                    try {
                        // Check extension context before making APP call
                        if (!isExtensionContextValid()) {
                            throw new Error("Extension context invalidated. Please refresh the page and try again.");
                        }
                        
                        const response = await browserAPI.runtime.sendMessage({
                            type: "DELETE_COMMENT",
                            commentId: commentId || reply.id
                        });
                        
                        if (response.success) {
                            // Remove from display
                            replyEl.remove();
                            comment.replyCount -= 1;
                        } else {
                            throw new Error(response.error);
                        }
                    } catch (error) {
                        console.error("Failed to delete reply:", error);
                        alert("Failed to delete reply: " + error.message);
                    } finally {
                        confirmDialog.remove();
                    }
                });
                
                cancelBtn.addEventListener('click', () => {
                    confirmDialog.remove();
                });

                confirmBtn.focus();
            });
            
            replyActions.appendChild(editButton);
            replyActions.appendChild(removeButton);
            replyContent.appendChild(replyActions);
        }
        
        replyEl.innerHTML = `
            <img src="${reply.authorProfileImageUrl}" style="width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;">
        `;
        replyEl.appendChild(replyContent);
        
        repliesContainer.appendChild(replyEl);
    }

    const fetchReplies = async (commentId, repliesContainer, comment) => {
        if (repliesContainer.children.length === 0) {
            const replies = await YouTubeAPI.fetchRepliesIfNeeded(commentId);
            replies.forEach(reply => {
                createReplyElement(reply, repliesContainer, comment);
            });
        }
    };

    let mouseHoveringOverComment = false;
    const createCommentElement = (comment) => {
        const el = document.createElement("div");
        el.className = "yt-timestamped-comment";
        el.style.cssText = `
            background-color: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 10px;
            margin-bottom: 10px;
            border-radius: 8px;
            display: flex;
            gap: 10px;
            opacity: 0;
            cursor: text;
            max-width: 100%;
            word-wrap: break-word;
            align-items: flex-start;
            will-change: opacity, transform;
            user-select: text;
        `;
        
        // Add initial opacity and transform transition
        el.style.transition = 'opacity 0.3s ease, transform 0.2s ease';
        setTimeout(() => el.style.opacity = '1', 0);
        
        // Add smooth hover effect for comment
        el.addEventListener("mouseenter", () => {
            el.style.transform = "scale(1.01)";
            mouseHoveringOverComment = true;
        });
        el.addEventListener("mouseleave", () => {
            el.style.transform = "scale(1)";
            mouseHoveringOverComment = false;
        });

        const img = document.createElement("img");
        img.src = comment.authorProfileImageUrl;
        img.style.cssText = `
            width: 40px;
            height: 40px;
            border-radius: 50%;
            flex-shrink: 0;
        `;

        const content = document.createElement("div");
        content.className = "comment-content";
        content.style.flexGrow = "1";
        const commentText = cleanCommentText(comment.textDisplay);
        const highlightedText = commentText.replace(
            /(?:\d+:)?[0-5]?\d:[0-5]\d/g,
            match => `<span style="color: #3ea6ff; font-weight: bold;">${match}</span>`
        );

        const formattedDate = formatDate(comment.publishedAt);
        content.innerHTML = `
            <div style="font-weight: bold">${comment.authorDisplayName}</div>
            <div>${highlightedText}</div>
            <div style="font-size: 0.8em; color: #aaa">
                ${comment.likeCount} likes · <span title="${formattedDate.tooltip}" style="cursor: help; border-bottom: 1px dotted rgba(255, 255, 255, 0.3);">${formattedDate.exactDate} · ${formattedDate.timeAgo}</span>
            </div>
        `;
        
        // Create action buttons container
        const actionsContainer = document.createElement("div");
        actionsContainer.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
        `;

        // Check if user is authenticated for reply functionality
        if (isExtensionContextValid()) {
            browserAPI.storage.local.get(['oauthToken'], (result) => {
                const hasOAuthToken = !!result.oauthToken;
                
                if (hasOAuthToken) {
                    // Get user's channel ID if not already retrieved
                    if (!userChannelId) {
                        getUserChannelId();
                    }
                    // Reply button with built-in text box
                    const replyButton = document.createElement("button");
                    replyButton.textContent = "💬 Reply";
                    replyButton.style.cssText = `
                        background: rgba(0, 123, 255, 0.8);
                        color: white;
                        border: 1px solid rgba(0, 123, 255, 0.3);
                        padding: 4px 8px;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                        transition: all 0.2s ease;
                    `;
                    replyButton.addEventListener("mouseenter", () => {
                        replyButton.style.background = "rgba(0, 123, 255, 1)";
                        replyButton.style.transform = "scale(1.05)";
                    });
                    replyButton.addEventListener("mouseleave", () => {
                        replyButton.style.background = "rgba(0, 123, 255, 0.8)";
                        replyButton.style.transform = "scale(1)";
                    });
                    replyButton.addEventListener("click", () => {
                        // Close any existing reply or edit interfaces
                        const existingReplyInterface = document.querySelector('[data-reply-interface]');
                        const existingEditInterface = document.querySelector('[data-edit-interface]');
                        
                        if (existingReplyInterface) {
                            existingReplyInterface.remove();
                            return; // Don't open new one if we just closed one
                        }
                        if (existingEditInterface) {
                            existingEditInterface.remove();
                        }
                        
                        // Create built-in reply interface as absolute positioned overlay
                        const replyInterface = document.createElement("div");
                        replyInterface.setAttribute("data-reply-interface", "true");
                        replyInterface.style.cssText = `
                            position: fixed;
                            top: 50%;
                            left: 50%;
                            transform: translate(-50%, -50%) scale(0.9);
                            opacity: 0;
                            z-index: 999999;
                            background: rgba(28, 28, 28, 0.95);
                            border: 1px solid rgba(255, 255, 255, 0.2);
                            border-radius: 8px;
                            padding: 16px;
                            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                            backdrop-filter: blur(10px);
                            min-width: 400px;
                            max-width: 600px;
                            transition: all 0.2s ease;
                        `;
                        
                        const replyInput = document.createElement("textarea");
                        replyInput.style.cssText = `
                            width: 100%;
                            height: 80px;
                            padding: 8px;
                            border: 1px solid rgba(255, 255, 255, 0.3);
                            border-radius: 4px;
                            resize: none;
                            font-family: Arial, sans-serif;
                            font-size: 14px;
                            background: rgba(255, 255, 255, 0.1);
                            color: white;
                            margin-bottom: 12px;
                            transition: border-color 0.2s ease;
                            box-sizing: border-box;
                        `;
                        replyInput.placeholder = "Write your reply...";
                        
                        replyInput.addEventListener("keydown", (e) => {
                            // Ctrl + Enter to send the reply
                            if (e.ctrlKey && e.key === 'Enter') {
                                e.preventDefault();
                                const text = replyInput.value.trim();
                                if (text) {
                                    sendButton.click();
                                }
                            }
                            // Escape to cancel
                            if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelButton.click();
                            }
                        });
                        
                        // Add focus effect for input
                        replyInput.addEventListener("focus", () => {
                            replyInput.style.borderColor = "rgba(255, 255, 255, 0.6)";
                        });
                        replyInput.addEventListener("blur", () => {
                            replyInput.style.borderColor = "rgba(255, 255, 255, 0.3)";
                        });
                        
                        const replyActions = document.createElement("div");
                        replyActions.style.cssText = `
                            display: flex;
                            gap: 8px;
                            justify-content: flex-end;
                        `;
                        
                        const sendButton = document.createElement("button");
                        sendButton.textContent = "Send";
                        sendButton.style.cssText = `
                            background: rgba(40, 167, 69, 0.8);
                            color: white;
                            border: 1px solid rgba(40, 167, 69, 0.3);
                            padding: 8px 16px;
                            border-radius: 4px;
                            cursor: pointer;
                            font-size: 12px;
                            transition: all 0.2s ease;
                        `;
                        
                        const cancelButton = document.createElement("button");
                        cancelButton.textContent = "Cancel";
                        cancelButton.style.cssText = `
                            background: rgba(108, 117, 125, 0.8);
                            color: white;
                            border: 1px solid rgba(108, 117, 125, 0.3);
                            padding: 8px 16px;
                            border-radius: 4px;
                            cursor: pointer;
                            font-size: 12px;
                            transition: all 0.2s ease;
                        `;
                        
                        // Add button hover effects
                        sendButton.addEventListener("mouseenter", () => {
                            sendButton.style.background = "rgba(40, 167, 69, 1)";
                            sendButton.style.transform = "scale(1.05)";
                        });
                        sendButton.addEventListener("mouseleave", () => {
                            sendButton.style.background = "rgba(40, 167, 69, 0.8)";
                            sendButton.style.transform = "scale(1)";
                        });
                        
                        cancelButton.addEventListener("mouseenter", () => {
                            cancelButton.style.background = "rgba(108, 117, 125, 1)";
                            cancelButton.style.transform = "scale(1.05)";
                        });
                        cancelButton.addEventListener("mouseleave", () => {
                            cancelButton.style.background = "rgba(108, 117, 125, 0.8)";
                            cancelButton.style.transform = "scale(1)";
                        });
                        
                        sendButton.addEventListener("click", async () => {
                            const text = replyInput.value.trim();
                            if (text) {
                                try {
                                    // Check extension context before making APP call
                                    if (!isExtensionContextValid()) {
                                        throw new Error("Extension context invalidated. Please refresh the page and try again.");
                                    }

                                    // Border to green
                                    replyInput.style.borderColor = "rgba(40, 167, 69, 0.8)";
                                    // Clear the input and hide interface
                                    replyInterface.remove();
                                    const response = await browserAPI.runtime.sendMessage({
                                        type: "REPLY_COMMENT",
                                        parentId: comment.id,
                                        text: text
                                    });
                                
                                    if (response && response.success) {
                                        comment.replyCount += 1;

                                        content.querySelector('.yt-timestamped-comment-expand-button').textContent = `▲ ${comment.replyCount} ${comment.replyCount === 1 ? 'reply' : 'replies'}`;
                                        const repliesContainer = content.querySelector('.yt-timestamped-comment-replies');
                                        repliesContainer.style.display = "block";

                                        createReplyElement(response.data.snippet, repliesContainer, comment, response.data.id);

                                    } else {
                                        // Enhanced error logging
                                        const errorMsg = response ? response.error : "Unknown error - no response received";
                                        throw new Error(errorMsg || "Failed to reply to comment");
                                    }
                                } catch (error) {
                                    console.error(error);
                                    replyInput.style.borderColor = "rgba(220, 53, 69, 0.8)";
                                    setTimeout(() => {
                                        replyInput.style.borderColor = "rgba(255, 255, 255, 0.3)";
                                    }, 2000);
                                }
                            }
                        });
                        
                        cancelButton.addEventListener("click", () => {
                            replyInterface.remove();
                        });
                        
                        replyActions.appendChild(sendButton);
                        replyActions.appendChild(cancelButton);
                        
                        replyInterface.appendChild(replyInput);
                        replyInterface.appendChild(replyActions);
                        
                        // Append to document body and animate in
                        document.body.appendChild(replyInterface);
                        
                        // Animate in
                        requestAnimationFrame(() => {
                            replyInterface.style.transform = "translate(-50%, -50%) scale(1)";
                            replyInterface.style.opacity = "1";
                        });
                        
                        replyInput.focus();
                    });

                    actionsContainer.appendChild(replyButton);
                }
            });
        }

        // Create expand/collapse button
        const expandButton = document.createElement("button");
        expandButton.className = "yt-timestamped-comment-expand-button";
        // Set initial button state to expanded if more than 0 replies
        expandButton.textContent = `▼ ${comment.replyCount} ${comment.replyCount === 1 ? 'reply' : 'replies'}`;
        expandButton.style.cssText = `
            background: none;
            color: #3ea6ff;
            border: none;
            padding: 4px 0;
            cursor: pointer;
            font-size: 12px;
            margin-top: 8px;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 4px;
        `;

        // Add expand button to actionsContainer (left side)
        actionsContainer.appendChild(expandButton);

        // Create replies container with expandable arrow
        
        const repliesContainer = document.createElement("div");
        repliesContainer.className = "yt-timestamped-comment-replies";
        repliesContainer.style.cssText = `
            display: block; // Show replies by default
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
        `;
        
        // Toggle replies visibility
        expandButton.addEventListener("click", () => {
            
            if (repliesContainer.style.display === "none") {
                expandButton.textContent = `▲ ${comment.replyCount} ${comment.replyCount === 1 ? 'reply' : 'replies'}`;
                repliesContainer.style.display = "block";
                fetchReplies(comment.id, repliesContainer, comment); // Fetch replies when expanding
            } else {
                expandButton.textContent = `▼ ${comment.replyCount} ${comment.replyCount === 1 ? 'reply' : 'replies'}`;
                repliesContainer.style.display = "none";
            }
        });
        
        // Set initial button state to expanded if more than 0 replies
        if (comment.replyCount > 0) {
            expandButton.textContent = `▲ ${comment.replyCount} ${comment.replyCount === 1 ? 'reply' : 'replies'}`;
            repliesContainer.style.display = "block";
        } else {
            expandButton.textContent = `▼ ${comment.replyCount} ${comment.replyCount === 1 ? 'reply' : 'replies'}`;
            repliesContainer.style.display = "none";
        }
        
        // Add hover effect for expand button
        expandButton.addEventListener("mouseenter", () => {
            expandButton.style.color = "#66b3ff";
            expandButton.style.transform = "scale(1.05)";
        });
        expandButton.addEventListener("mouseleave", () => {
            expandButton.style.color = "#3ea6ff";
            expandButton.style.transform = "scale(1)";
        });

        content.appendChild(actionsContainer);
        content.appendChild(repliesContainer);

        el.appendChild(img);
        el.appendChild(content);

        // Add click handler to open comment in new tab
        el.addEventListener("click", (e) => {
            // Don't trigger if clicking inside replies, buttons, or not holding control
            if (e.target.closest('.yt-timestamped-comment-replies') || 
                e.target.closest('button') || 
                !e.ctrlKey) {
                return;
            }
            const videoUrl = `https://www.youtube.com/watch?v=${currentVideo}&lc=${comment.id}`;
            window.open(videoUrl, '_blank');
        });

        return el;
    };

    const displayComment = (comment) => {
        if (displayedComments.has(comment.id)) return;
        
        const commentEl = createCommentElement(comment);
        
        // Insert new comments at the top of the container
        if (commentContainer.firstChild) {
            commentContainer.insertBefore(commentEl, commentContainer.firstChild);
        } else {
            commentContainer.appendChild(commentEl);
        }
        
        displayedComments.add(comment.id);

        fetchReplies(comment.id, commentEl.querySelector('.yt-timestamped-comment-replies'), comment);

        const removeComment = () => {
            // Only remove if not paused or if mouse not hovering over it
            if (!isPaused && !mouseHoveringOverComment) {
                if (commentEl.parentNode) {
                    commentEl.style.opacity = "0";
                    setTimeout(() => {
                        commentEl.remove();
                        displayedComments.delete(comment.id);
                    }, 300);
                }
            } else {
                // If paused, check again in 1 second
                setTimeout(removeComment, 1000);
            }
        };

        setTimeout(removeComment, COMMENT_DISPLAY_DURATION);
    };

    const checkForTimestampedComments = () => {
        if (!youtubePlayer || isPaused) return;
        
        const currentTime = youtubePlayer.currentTime;
        const speedRange = getPlaybackSpeedRange();

        commentCache.forEach(comment => {
            const commentTime = comment.timestampSeconds;
            
            if (
                Math.abs(currentTime - commentTime) <= speedRange &&
                !displayedComments.has(comment.id)
            ) {
                displayComment(comment);
            }
        });
    };

    const timestampToSeconds = (timestamp) => {
        const parts = timestamp.split(':').map(Number);
        return parts.length === 3
            ? parts[0] * 3600 + parts[1] * 60 + parts[2]
            : parts[0] * 60 + parts[1];
    };

    const getPlaybackSpeedRange = () => {
        // Get current playback speed
        const playbackRate = youtubePlayer.playbackRate || 1;
        
        // Dynamic range based on playback speed
        // 1x speed: ±1 second
        // 2x speed: ±2 seconds
        // 3x speed: ±3 seconds
        return Math.floor(playbackRate);
    };

    const createLoadingIndicator = () => {
        const loader = document.createElement("div");
        loader.className = "yt-timestamped-comment-loader";
        loader.style.cssText = `
            background-color: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 15px 25px;
            border-radius: 8px;
            text-align: center;
            margin: 10px;
            min-width: 300px;
            position: relative;
        `;
        
        loader.innerHTML = `
            <div class="loader-text">Loading comments...</div>
            <button class="cancel-loader" style="
                position: absolute;
                top: -5px;
                right: -5px;
                background: none;
                border: none;
                border-radius: 50%;
                width: 25px;
                height: 25px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                z-index: 10;
                overflow: hidden;
                transform-origin: center;
                transition: transform 0.2s ease;
            ">
                <img src="${browserAPI.runtime.getURL('assets/cancel.png')}" alt="Cancel" style="
                    width: 25px; 
                    height: 25px; 
                    object-fit: cover; 
                    border-radius: 50%; 
                    transform: scale(var(--youtube-player-scale));
                    transition: transform 0.2s ease;
                ">
            </button>
            <div class="loader-progress-container" style="
                width: 100%;
                height: 4px;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 2px;
                margin: 15px 0;
            ">
                <div class="loader-progress-bar" style="
                    width: 0%;
                    height: 100%;
                    background: #ff0000;
                    border-radius: 2px;
                    transition: width 0.3s ease;
                "></div>
            </div>
            <div class="loader-stats" style="
                display: flex;
                justify-content: space-between;
                font-size: 0.9em;
                color: #aaa;
                gap: 20px;
            ">
                <div class="comments-cached">Comments cached: 0</div>
                <div class="total-comments">Total comments: --</div>
            </div>
        `;

        const closeLoaderBtn = loader.querySelector('.cancel-loader');
        closeLoaderBtn.addEventListener('mouseenter', () => {
            closeLoaderBtn.style.transform = 'scale(1.2)';
        });
        closeLoaderBtn.addEventListener('mouseleave', () => {
            closeLoaderBtn.style.transform = 'scale(1)';
        });

        return loader;
    };

    const fetchComments = async () => {
        if (!currentVideo || isLoading) return;
    
        isLoading = true;
        const loader = createLoadingIndicator();
        loader.style.animation = 'pulse 1.5s infinite'; // Add loading animation
        commentContainer.appendChild(loader);
    
        let cancelReason = CancelReason.None; // Initialize cancel reason
        let hasError = false; // Flag to track if error occurred

        getCommentsEnabledSetting().then((enabled) => {
            isCommentsEnabled = enabled;
            if (isCommentsEnabled === false) {
                cancelReason = CancelReason.isCommentsDisabled; // Set cancel reason
            }
        }).catch((error) => {
            console.error('Error getting comments enabled setting:', error);
            // Default to enabled if there's an error
            isCommentsEnabled = true;
        });
    
        try {
            // Get total comment count and adjust for timestamped comments ratio
            const totalComments = await YouTubeAPI.getTotalComments(currentVideo);
            const estimatedTimestampedComments = Math.ceil(totalComments / 1.41); // Adjust ratio based on observation
            
            // Update progress callback
            const updateProgress = (cached) => {
                const loaderText = loader.querySelector('.loader-text');
                const statsEl = loader.querySelector('.loader-stats');
                const progressBar = loader.querySelector('.loader-progress-bar');
                
                if (loaderText && statsEl && progressBar) {
                    statsEl.innerHTML = `
                        <div class="comments-cached">Comments cached: ${cached}</div>
                        <div class="total-comments">Total comments: ${estimatedTimestampedComments}</div>
                    `;
                    // Update progress bar
                    if (estimatedTimestampedComments > 0) {
                        const progress = (cached / estimatedTimestampedComments) * 100;
                        progressBar.style.width = `${Math.min(progress, 100)}%`;
                    }
                }
    
                if (MAX_COMMENT_CACHE > 0 && cached >= MAX_COMMENT_CACHE) {
                    cancelReason = CancelReason.MaxCommentCacheLimit; // Set cancel reason
                }
            };
    
            // Cancel button click handler
            const cancelLoader = () => {
                cancelReason = CancelReason.CancelButtonClicked; // Set cancel reason
            };
            const cancelLoaderButton = loader.querySelector('.cancel-loader');
            if (cancelLoaderButton) {
                cancelLoaderButton.addEventListener('click', cancelLoader);
            }
    
            // Cancel progress callback
            const cancelProgress = () => {
                return cancelReason !== CancelReason.None;
            };
            
            // Fetch raw comments
            const rawComments = await YouTubeAPI.fetchAllComments(currentVideo, updateProgress, cancelProgress);
            
            // Check if video changed during loading
            if (!commentContainer || !commentContainer.parentNode) {
                return; // Exit if container was removed
            }
            
            // Process comments
            commentCache = processComments(rawComments);
            console.log(`Loaded ${commentCache.length} timestamped comments`);
    
            // Update final stats based on cancelReason
            const loaderText = loader.querySelector('.loader-text');
            const statsEl = loader.querySelector('.loader-stats');
            const progressBar = loader.querySelector('.loader-progress-bar');
            
            if (loaderText && statsEl && progressBar) {

                statsEl.style.justifyContent = 'center';

                if (cancelReason === CancelReason.isCommentsDisabled) {
                    loaderText.textContent = 'Disabled';
                    statsEl.innerHTML = '<div>Timestamped Comments are disabled.</div>';
                    progressBar.style.width = '100%';
                    progressBar.style.background = 'red';

                } else {
                    loaderText.textContent = `Timestamped comments: ${commentCache.length}`;
                    statsEl.innerHTML = `
                        <div class="comments-cached">Comments cached: ${rawComments.length}</div>
                    `;
                    progressBar.style.width = '100%';
                    if (cancelReason === CancelReason.CancelButtonClicked || cancelReason === CancelReason.MaxCommentCacheLimit)
                        progressBar.style.background = 'red';
                    else
                        progressBar.style.background = '#00ff00';
                }
                
                // Stop the pulse animation
                loader.style.animation = 'none';
            }
    
            // Wait for both conditions:
            // 1. Initial 2-second delay
            // 2. Video is playing
            await Promise.all([
                new Promise(resolve => setTimeout(resolve, 2000)),
                waitForVideoPlaying()
            ]);
            
            // Add fade out animation
            loader.style.transition = 'opacity 0.3s ease-out';
            loader.style.opacity = '0';
            await new Promise(resolve => setTimeout(resolve, 300));
    
        } catch (error) {
            hasError = true;
            
            // Update loader to show error message
            if (loader && loader.parentNode) {
                const loaderText = loader.querySelector('.loader-text');
                const statsEl = loader.querySelector('.loader-stats');
                const progressBar = loader.querySelector('.loader-progress-bar');
                
                if (loaderText && statsEl && progressBar) {
                    loaderText.textContent = 'Unable to fetch comments';
                    statsEl.innerHTML = '<div>Failed to load comments after 3 attempts</div>';
                    progressBar.style.width = '100%';
                    progressBar.style.background = 'red';
                    loader.style.animation = 'none';
                    
                    // Remove loader after showing error
                    setTimeout(() => {
                        loader.style.transition = 'opacity 0.3s ease-out';
                        loader.style.opacity = '0';
                        setTimeout(() => {
                            if (loader.parentNode) {
                                loader.remove();
                            }
                        }, 300);
                    }, 3000);
                }
            }
        } finally {
            isLoading = false;
            // Only remove loader if there was no error (error case handles its own removal)
            if (loader && loader.parentNode && !hasError) {
                loader.remove();
            }
        }
    };

    const setupContextMenuPrevention = () => {
        if (!commentContainer) return;
        
        // Use a passive event listener for better performance
        commentContainer.addEventListener('contextmenu', (e) => {
            const target = e.target;
            // Quick class check first before using more expensive closest()
            if (target.classList.contains('yt-timestamped-comment') || 
                target.classList.contains('yt-timestamped-comment-reply') ||
                target.closest('.yt-timestamped-comment, .yt-timestamped-comment-reply')) {
                e.stopPropagation();
            }
        }, { capture: true, passive: true }); // Mark as passive for better scrolling performance
    };

    function getCommentsEnabledSetting() {
        return new Promise((resolve) => {
            browserAPI.storage.local.get(['commentsEnabled'], (result) => {
                const enabled = result.commentsEnabled !== false;
                resolve(enabled);
            });
        });
    }

    const newVideoLoaded = () => {
        // Clear previous state
        commentCache = [];
        displayedComments.clear();
        
        // Clear any existing interval
        if (commentCheckInterval) {
            clearInterval(commentCheckInterval);
            commentCheckInterval = null;
        }

        // Remove existing comment container if it exists
        if (commentContainer && commentContainer.parentNode) {
            commentContainer.parentNode.removeChild(commentContainer);
            commentContainer = null;
        }
        
        // Reset loading state
        isLoading = false;
        
        // Create new comment container
        commentContainer = createCommentContainer();

        // Add context menu prevention
        setupContextMenuPrevention();
        
        // Repeat finding 
        // Add comment container to the video player
        const playerContainer = document.querySelector('#movie_player') || 
        document.querySelector('ytd-player') || 
        document.body;
        playerContainer.appendChild(commentContainer);

        // Fetch comments for the new video
        fetchComments();

        // Request OAuth key refresh on video load
        if (typeof browserAPI !== 'undefined' && browserAPI.runtime) {
            browserAPI.runtime.sendMessage({ type: "REFRESH_OAUTH_KEY" }, (response) => {
                if (response.success) {
                    console.log('OAuth key refresh completed on video load');
                    // Call getUserChannelId after OAuth key is obtained
                    getUserChannelId();
                } else {
                    console.error('OAuth key refresh failed on video load:', response.error);
                }
            });
        }
        
        // Start checking for timestamped comments
        commentCheckInterval = setInterval(checkForTimestampedComments, 1000);
    };

    const waitForVideoPlaying = async () => {
        const player = document.querySelector('video');
        if (!player) return;

        // Wait until video is playing
        while (player.paused) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    };

})();
