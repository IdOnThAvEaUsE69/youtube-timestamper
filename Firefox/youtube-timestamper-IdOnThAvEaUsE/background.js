// Use browser namespace (works in both Chrome and Firefox)
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Track the last processed video ID to prevent duplicate processing
let lastProcessedVideoId = null;

// Function to extract video ID from URL
const extractVideoId = (url) => {
  try {
    // Handle different YouTube URL formats
    const urlObj = new URL(url);
    
    // Check for standard watch URL
    if (urlObj.pathname === '/watch') {
      return urlObj.searchParams.get('v');
    }
    
    // Check for youtu.be short URLs
    if (urlObj.hostname === 'youtu.be') {
      return urlObj.pathname.slice(1);
    }
    
    return null;
  } catch (error) {
    return null;
  }
};

// Main listener for tab updates
browserAPI.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Check for URL changes (SPA navigation) or page load completion
  if (
    tab.url && 
    (tab.url.includes('youtube.com/watch') || tab.url.includes('youtu.be/')) &&
    (changeInfo.status === 'complete' || changeInfo.url)
  ) {
    const videoId = extractVideoId(tab.url);
    
    if (videoId && videoId !== lastProcessedVideoId) {
      lastProcessedVideoId = videoId;
      
      // Attempt to send message to content script
      browserAPI.tabs.sendMessage(tabId, {
        type: "NEW",
        videoId: videoId
      }).catch(error => {
        // Ignore any error from the message sending
        console.debug('Message sending failed (tab may have changed):', error.message);
      });
    }
  }
});

// Function to get stored token
async function getStoredToken() {
  return new Promise((resolve) => {
    browserAPI.storage.local.get(['oauthToken'], (result) => {
      resolve(result.oauthToken || null);
    });
  });
}

// Function to get OAuth key via Cloudflare Worker proxy
async function getOAuthKeyFromRefreshToken() {
  return new Promise((resolve, reject) => {
    browserAPI.storage.local.get(['oauthToken'], (result) => {
      const refreshToken = result.oauthToken;
      
      if (!refreshToken) {
        reject(new Error('No refresh token available'));
        return;
      }
      
      // Ping your Cloudflare Worker endpoint instead of Google directly
      fetch('https://yt-timestamper-refresh-2.idonthaveause.workers.dev/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          refresh_token: refreshToken
        })
      })
      .then(response => {
        console.log('Worker proxy response status:', response.status);
        return response.json();
      })
      .then(data => {
                
        // Match the custom keys returned by your handleRefresh worker logic
        if (data.success && data.accessToken) {
          // Store the access token and calculate local expiration time
          const expiresAt = Date.now() + (data.expiresIn * 1000);
          
          browserAPI.storage.local.set({
            oauthKey: data.accessToken,
            oauthKeyExpiresAt: expiresAt
          }, () => {
            console.log('OAuth key obtained and saved successfully via Worker');
            resolve(data.accessToken);
          });
        } else {
          reject(new Error(data.error || 'Failed to exchange token via Worker proxy'));
        }
      })
      .catch(error => {
        console.error('Network error during worker fetch:', error);
        reject(error);
      });
    });
  });
}

// Function to get valid OAuth key (refresh if needed)
async function getValidOAuthKey() {
  return new Promise((resolve, reject) => {
    browserAPI.storage.local.get(['oauthKey', 'oauthKeyExpiresAt'], (result) => {
      const oauthKey = result.oauthKey;
      const expiresAt = result.oauthKeyExpiresAt;
      
      // Check if OAuth key is valid (not expired for at least 5 minutes)
      if (oauthKey && expiresAt && Date.now() < (expiresAt - 300000)) {
        resolve(oauthKey);
      } else {
        // Need to refresh OAuth key
        getOAuthKeyFromRefreshToken()
          .then(newOAuthKey => {
            resolve(newOAuthKey);
          })
          .catch(error => {
            reject(error);
          });
      }
    });
  });
}

// Function to reply to a comment
async function replyToComment(parentId, text) {
  const token = await getValidOAuthKey();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const response = await fetch(
    'https://www.googleapis.com/youtube/v3/comments?part=snippet',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        snippet: {
          parentId: parentId,
          textOriginal: text
        }
      })
    }
  );

  if (!response.ok) {
    const errorData = await response.json();
    console.error('Reply comment API error:', errorData);
    throw new Error(`Failed to reply to comment: ${errorData.error?.message || response.statusText}`);
  }

  return response.json();
}

// Function to edit a comment
async function editComment(commentId, newText) {
  const token = await getValidOAuthKey();
  if (!token) {
    throw new Error('Not authenticated');
  }

  // First get the comment to get current state
  const getResponse = await fetch(
    `https://www.googleapis.com/youtube/v3/comments?id=${commentId}&part=snippet`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!getResponse.ok) {
    const errorData = await getResponse.json();
    throw new Error(`Failed to get comment: ${errorData.error?.message || getResponse.statusText}`);
  }

  const commentData = await getResponse.json();
  const comment = commentData.items[0];

  // Update the comment text
  comment.snippet.textOriginal = newText;

  // Update the comment
  const updateResponse = await fetch(
    'https://www.googleapis.com/youtube/v3/comments?part=snippet',
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(comment)
    }
  );

  if (!updateResponse.ok) {
    const errorData = await updateResponse.json();
    console.error('Edit comment API error:', errorData);
    throw new Error(`Failed to edit comment: ${errorData.error?.message || updateResponse.statusText}`);
  }

  return await updateResponse.json();
}

// Function to delete a comment
async function deleteComment(commentId) {
  const token = await getValidOAuthKey();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/comments?id=${commentId}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!response.ok) {
    const errorData = await response.json();
    console.error('Delete comment API error:', errorData);
    throw new Error(`Failed to delete comment: ${errorData.error?.message || response.statusText}`);
  }

  return { success: true };
}

// Function to get user channel information
async function getUserInfo(channelId) {
  const token = await getValidOAuthKey();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?id=${channelId}&part=snippet`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!response.ok) {
    const errorData = await response.json();
    console.error('Get user info API error:', errorData);
    throw new Error(`Failed to get user info: ${errorData.error?.message || response.statusText}`);
  }

  const data = await response.json();
  const channel = data.items[0];
  
  return {
    displayName: channel.snippet.title,
    profileImageUrl: channel.snippet.thumbnails.default.url
  };
}

// Refresh OAuth key on extension startup
getValidOAuthKey().then(() => {
  console.log('OAuth key refresh completed on startup');
}).catch(error => {
  console.error('OAuth key refresh failed on startup:', error);
});

// Listener for runtime messages
browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "GET_VIDEO_ID") {
    sendResponse({ videoId: lastProcessedVideoId });
  } else if (request.type === "REPLY_COMMENT") {
    replyToComment(request.parentId, request.text).then(response => {
      sendResponse({ success: true, data: response });
    }).catch(error => {
      console.error('Error replying to comment:', error);
      sendResponse({ error: error.message });
    });
  } else if (request.type === "EDIT_COMMENT") {
    editComment(request.commentId, request.newText).then(response => {
      sendResponse({ success: true, data: response });
    }).catch(error => {
      console.error('Error editing comment:', error);
      sendResponse({ error: error.message });
    });
  } else if (request.type === "DELETE_COMMENT") {
    deleteComment(request.commentId).then(response => {
      sendResponse({ success: true, data: response });
    }).catch(error => {
      console.error('Error deleting comment:', error);
      sendResponse({ error: error.message });
    });
  } else if (request.type === "GET_USER_INFO") {
    getUserInfo(request.channelId).then(response => {
      sendResponse({ success: true, displayName: response.displayName, profileImageUrl: response.profileImageUrl });
    }).catch(error => {
      console.error('Error getting user info:', error);
      sendResponse({ error: error.message });
    });
  } else if (request.type === "SET_REFRESH_TOKEN") {
    // Handle refresh token from OAuth server
    if (request.token) {
      browserAPI.storage.local.set({ oauthToken: request.token }, () => {
        console.log('Refresh token saved from OAuth server');
        sendResponse({ success: true });
      });
    } else {
      sendResponse({ success: false, error: 'No token provided' });
    }
  } else if (request.type === "GET_OAUTH_KEY") {
    getValidOAuthKey().then(oauthKey => {
      sendResponse({ success: true, oauthKey: oauthKey });
    }).catch(error => {
      console.error('Failed to get OAuth key:', error);
      sendResponse({ error: error.message });
    });
  } else if (request.type === "REFRESH_OAUTH_KEY") {
    getValidOAuthKey().then(() => {
      sendResponse({ success: true, message: 'OAuth key refresh completed' });
    }).catch(error => {
      console.error('Manual OAuth key refresh error:', error);
      sendResponse({ error: error.message });
    });
  }
  return true;  // Will respond asynchronously
});