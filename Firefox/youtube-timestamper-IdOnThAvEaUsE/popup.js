document.addEventListener('DOMContentLoaded', () => {
    const commentDurationInput = document.getElementById('commentDuration');
    const maxCommentCacheInput = document.getElementById('maxCommentCache');
    const toggleCommentsInput = document.getElementById('toggleComments');
    const apiKeyInput = document.getElementById('apiKeyInput');
    const oauthTokenInput = document.getElementById('oauthTokenInput');
    const saveButton = document.getElementById('saveSettings');
    const statusDiv = document.getElementById('status');
    const accountButton = document.getElementById('accountButton');

    // Load saved settings
    chrome.storage.local.get(
        ['commentDuration', 'maxCommentCache', 'commentsEnabled', 'app', 'oauthToken'], 
        (result) => {
            commentDurationInput.value = result.commentDuration || 4;
            maxCommentCacheInput.value = result.maxCommentCache || 0;
            toggleCommentsInput.checked = result.commentsEnabled !== false; // Default to true

            // Load APP key
            apiKeyInput.value = result.app || "";
            
            // Load refresh token
            if (result.oauthToken) {
                oauthTokenInput.value = result.oauthToken;
            }
        }
    );

    // Handle toggle change for comments
    toggleCommentsInput.addEventListener('change', () => {
        const isEnabled = toggleCommentsInput.checked;
        chrome.storage.local.set({ commentsEnabled: isEnabled }, () => {
            // Send message to content script
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (chrome.runtime.lastError || !tabs[0]) {
                    console.log('Unable to send message to active tab');
                    return;
                }

                try {
                    chrome.tabs.sendMessage(tabs[0].id, { 
                        type: 'TOGGLE_COMMENTS',
                        enabled: isEnabled
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.log('Error sending message:', chrome.runtime.lastError);
                        }
                    });
                } catch (error) {
                    console.log('Error sending message:', error);
                }
            });
        });
    });

    // Handle account button click
    accountButton.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://yt-timestamper-refresh-2.idonthaveause.workers.dev' });
    });

    // Save settings
    saveButton.addEventListener('click', () => {
        const commentDuration = parseInt(commentDurationInput.value, 10);
        const maxCommentCache = parseInt(maxCommentCacheInput.value, 10);

        // Validate inputs
        if (isNaN(commentDuration) || commentDuration < 1 || commentDuration > 10) {
            statusDiv.textContent = 'Invalid comment duration. Must be between 1-10.';
            return;
        }

        if (isNaN(maxCommentCache) || maxCommentCache < 0) {
            statusDiv.textContent = 'Invalid max comment cache. Must be 0 or positive.';
            return;
        }

        const app = apiKeyInput.value.trim();
        const oauthToken = oauthTokenInput.value.trim();

        // Save settings
        chrome.storage.local.set({
            commentDuration: commentDuration,
            maxCommentCache: maxCommentCache,
            commentsEnabled: toggleCommentsInput.checked,
            app: app,
            oauthToken: oauthToken
        }, () => {
            statusDiv.style.color = '#4caf50';
            statusDiv.textContent = 'Settings saved successfully!';

            // Clear status message after 2 seconds
            setTimeout(() => {
                statusDiv.textContent = '';
                statusDiv.style.color = '#cc0000';
            }, 2000);

            // Notify content script of settings change
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (chrome.runtime.lastError || !tabs[0]) {
                    console.log('Unable to send message to active tab');
                    return;
                }

                try {
                    chrome.tabs.sendMessage(tabs[0].id, { 
                        type: 'SETTINGS_UPDATED',
                        settings: {
                            commentDuration,
                            maxCommentCache,
                            app: app,
                            oauthToken: oauthToken
                        }
                    }, (response) => {
                        // Optional: handle response if needed
                        if (chrome.runtime.lastError) {
                            console.log('Error sending message:', chrome.runtime.lastError);
                        }
                    });
                } catch (error) {
                    console.log('Error sending message:', error);
                }
            });
        });
    });
});