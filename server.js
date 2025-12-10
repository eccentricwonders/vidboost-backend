const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const Stripe = require('stripe');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================
// YOUTUBE DATA API
// ============================================
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// ============================================
// DISCORD NOTIFICATIONS
// ============================================
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const sendDiscordNotification = async (message, type = 'info') => {
  if (!DISCORD_WEBHOOK_URL) return;
  
  const colors = {
    signup: 0x00ff00,    // Green
    premium: 0xffd700,   // Gold
    info: 0x7289da       // Discord blue
  };
  
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: message.title,
          description: message.description,
          color: colors[type] || colors.info,
          timestamp: new Date().toISOString(),
          footer: { text: 'VidBoost Alerts' }
        }]
      })
    });
    console.log('Discord notification sent!');
  } catch (error) {
    console.error('Discord notification failed:', error);
  }
};

// ============================================
// PRICING TIERS
// ============================================
// Premium Tier - $5.99/month or $49/year
const PREMIUM_MONTHLY_PRICE_ID = 'price_1ScYpECcNbRqQcCD8kFyAxAK';
const PREMIUM_YEARLY_PRICE_ID = 'price_1ScYriCcNbRqQcCDj9zEqkKX';

// Pro Tier - $14.99/month or $119/year (Coming Soon)
const PRO_MONTHLY_PRICE_ID = 'price_1SbmimERUSwMWdL0sw9eckhF';
const PRO_YEARLY_PRICE_ID = 'price_1SbmmJERUSwMWdL0Patiol8A';

// Toggle this to enable Pro tier purchases (set to true when ready)
const PRO_TIER_ENABLED = false;

// Waitlist storage (in production, use a database)
let proWaitlist = [];

// CORS - Allow frontend URLs
app.use(cors({
  origin: ['http://localhost:3000', 'https://vidboost-frontend.vercel.app', 'https://vidboost.app'],
  credentials: true
}));
app.use(express.json());

// Configure multer to preserve file extension
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Keep original extension
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${ext}`);
  }
});
const upload = multer({ storage: storage });

// ============================================
// STRIPE CHECKOUT
// ============================================

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { priceType, userId, tier } = req.body;
    
    let priceId;
    
    if (tier === 'pro') {
      // Check if Pro tier is enabled
      if (!PRO_TIER_ENABLED) {
        return res.status(400).json({ error: 'Pro tier is not yet available. Join the waitlist!' });
      }
      priceId = priceType === 'yearly' ? PRO_YEARLY_PRICE_ID : PRO_MONTHLY_PRICE_ID;
    } else {
      // Default to Premium tier
      priceId = priceType === 'yearly' ? PREMIUM_YEARLY_PRICE_ID : PREMIUM_MONTHLY_PRICE_ID;
    }
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: 'https://vidboost.app?success=true',
      cancel_url: 'https://vidboost.app?canceled=true',
      metadata: { userId: userId, tier: tier || 'premium' }
    });
    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PRO WAITLIST
// ============================================

app.post('/api/join-waitlist', async (req, res) => {
  try {
    const { email, userId } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Check if already on waitlist
    if (!proWaitlist.find(entry => entry.email === email)) {
      proWaitlist.push({ 
        email, 
        userId, 
        joinedAt: new Date().toISOString() 
      });
      console.log(`New waitlist signup: ${email}`);
    }
    
    res.json({ success: true, message: 'You\'ve been added to the Pro waitlist!' });
  } catch (error) {
    console.error('Waitlist error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/waitlist-count', async (req, res) => {
  res.json({ count: proWaitlist.length });
});

// ============================================
// NEW USER NOTIFICATIONS
// ============================================
app.post('/api/notify-signup', async (req, res) => {
  try {
    const { email, name } = req.body;
    
    await sendDiscordNotification({
      title: '🎉 New VidBoost Signup!',
      description: `**Email:** ${email}\n**Name:** ${name || 'Not provided'}`
    }, 'signup');
    
    console.log(`New signup notification sent for: ${email}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Signup notification error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/notify-premium', async (req, res) => {
  try {
    const { email, plan } = req.body;
    
    await sendDiscordNotification({
      title: '💰 New Premium Subscription!',
      description: `**Email:** ${email}\n**Plan:** ${plan}`
    }, 'premium');
    
    console.log(`Premium notification sent for: ${email}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Premium notification error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check if Pro tier is enabled
app.get('/api/pro-status', async (req, res) => {
  res.json({ enabled: PRO_TIER_ENABLED });
});

// ============================================
// AI THUMBNAIL GENERATOR
// ============================================

// Thumbnail limits per tier
const THUMBNAIL_LIMITS = {
  free: 1,        // 1 total (lifetime)
  premium: 3,     // 3 per month
  pro: 20         // 20 per month
};

app.post('/api/generate-thumbnail', async (req, res) => {
  console.log('=== THUMBNAIL REQUEST RECEIVED ===');
  try {
    const { videoTitle, videoTopic, transcriptSummary, style } = req.body;
    console.log('Video title:', videoTitle);
    console.log('Style:', style);
    
    if (!videoTitle && !videoTopic) {
      return res.status(400).json({ error: 'Video title or topic is required' });
    }
    
    // Build a detailed prompt for DALL-E
    const styleGuide = {
      'youtube': 'bold, eye-catching YouTube thumbnail with vibrant colors, dramatic lighting, and text-friendly composition',
      'minimal': 'clean, minimal, modern thumbnail with simple shapes and muted colors',
      'dramatic': 'cinematic, dramatic thumbnail with high contrast, moody lighting, and intense atmosphere',
      'colorful': 'bright, fun, colorful thumbnail with playful elements and energetic vibe',
      'professional': 'professional, corporate-style thumbnail with clean design and trustworthy appearance'
    };
    
    const selectedStyle = styleGuide[style] || styleGuide['youtube'];
    
    const prompt = `Create a ${selectedStyle}. 
    
Topic: ${videoTitle || videoTopic}
${transcriptSummary ? `Context: ${transcriptSummary.substring(0, 300)}` : ''}

Requirements:
- NO TEXT or letters in the image
- Leave space on the right or left side for text overlay
- High quality, 4K style rendering
- Visually striking and scroll-stopping
- Suitable as a video thumbnail`;

    console.log('Generating thumbnail with DALL-E...');
    console.log('Prompt preview:', prompt.substring(0, 150) + '...');
    
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: prompt,
      n: 1,
      size: "1792x1024",
      quality: "standard"
    });
    
    console.log('Thumbnail generated successfully!');
    const imageUrl = response.data[0].url;
    
    res.json({ 
      success: true, 
      imageUrl: imageUrl,
      revisedPrompt: response.data[0].revised_prompt 
    });
    
  } catch (error) {
    console.error('=== THUMBNAIL ERROR ===');
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    console.error('=======================');
    
    // Friendly message for content policy violations
    if (error.code === 'content_policy_violation') {
      return res.status(400).json({ 
        error: 'This video\'s content triggered AI safety filters. Try a different video or select a different style.',
        code: 'content_policy'
      });
    }
    
    res.status(500).json({ error: 'Failed to generate thumbnail: ' + error.message });
  }
});

// ============================================
// AI SCRIPT WRITER
// ============================================

app.post('/api/generate-script', async (req, res) => {
  console.log('=== SCRIPT GENERATION REQUEST ===');
  try {
    const { topic, length, style, targetAudience } = req.body;
    console.log('Topic:', topic);
    console.log('Length:', length);
    console.log('Style:', style);
    
    if (!topic) {
      return res.status(400).json({ error: 'Topic is required' });
    }
    
    const lengthGuide = {
      'short': '1-2 minutes (about 150-300 words)',
      'medium': '5-7 minutes (about 750-1000 words)',
      'long': '10-15 minutes (about 1500-2000 words)'
    };
    
    const styleGuide = {
      'educational': 'Clear, informative, and structured with facts and explanations',
      'entertaining': 'Fun, engaging, with humor and personality',
      'storytelling': 'Narrative-driven with a beginning, middle, and end',
      'tutorial': 'Step-by-step instructions that are easy to follow',
      'motivational': 'Inspiring and energetic with powerful messages'
    };
    
    const selectedLength = lengthGuide[length] || lengthGuide['medium'];
    const selectedStyle = styleGuide[style] || styleGuide['educational'];
    
    const prompt = `Write a complete YouTube video script on this topic: "${topic}"

TARGET LENGTH: ${selectedLength}
STYLE: ${selectedStyle}
${targetAudience ? `TARGET AUDIENCE: ${targetAudience}` : ''}

FORMAT THE SCRIPT EXACTLY LIKE THIS:

🎬 HOOK (First 5 seconds - grab attention immediately)
[Write a compelling hook that stops the scroll]

📖 INTRO (15-30 seconds)
[Introduce yourself and what the video is about, include a "watch until the end" teaser]

📍 MAIN CONTENT
[Break into clear sections with headers]

**Section 1: [Title]**
[Content for this section]

**Section 2: [Title]**
[Content for this section]

**Section 3: [Title]**
[Content for this section]

(Add more sections as needed for the length)

📣 CALL TO ACTION
[Ask viewers to like, subscribe, comment - make it specific and engaging]

👋 OUTRO (15-30 seconds)
[Wrap up, tease next video, final goodbye]

---

ADDITIONAL TIPS FOR FILMING:
[Include 3-5 specific tips for delivering this script on camera]

Make the script conversational and natural to speak out loud. Include [PAUSE] markers where the creator should take a breath or let information sink in.`;

    console.log('Generating script...');
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a professional YouTube scriptwriter who creates engaging, viral-worthy scripts. You understand pacing, hooks, and how to keep viewers watching." },
        { role: "user", content: prompt }
      ],
      max_tokens: 3000
    });
    
    const script = response.choices[0].message.content;
    console.log('Script generated successfully!');
    
    res.json({ 
      success: true, 
      script: script
    });
    
  } catch (error) {
    console.error('=== SCRIPT ERROR ===');
    console.error('Error message:', error.message);
    console.error('====================');
    res.status(500).json({ error: 'Failed to generate script: ' + error.message });
  }
});

// ============================================
// GLOBAL STATS TRACKING
// ============================================

let globalStats = {
  totalVideosAnalyzed: 0,
  scoreHistory: []
};
const MAX_SCORES = 1000;

function calculatePercentile(score) {
  if (globalStats.scoreHistory.length < 10) return null;
  const belowCount = globalStats.scoreHistory.filter(s => s < score).length;
  return Math.round((belowCount / globalStats.scoreHistory.length) * 100);
}

function addScoreToHistory(score) {
  globalStats.scoreHistory.push(score);
  globalStats.totalVideosAnalyzed++;
  if (globalStats.scoreHistory.length > MAX_SCORES) {
    globalStats.scoreHistory.shift();
  }
}

function extractOverallScore(videoScoreText) {
  const match = videoScoreText.match(/OVERALL SCORE:\s*(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

// ============================================
// AI ANALYSIS FUNCTIONS
// ============================================

async function generateVideoTips(transcription) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an expert video coach and content strategist. Analyze video transcriptions and provide specific, actionable tips to improve engagement, retention, and viral potential." },
        { role: "user", content: `Analyze this video transcription and provide 5 specific tips to make it more engaging and viral. Focus on: hooks, pacing, call-to-actions, storytelling, and audience retention.\n\nTranscription: ${transcription}` }
      ],
      max_tokens: 500
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating tips:', error);
    return "Tips could not be generated at this time.";
  }
}

async function generateTrendingAndIdeas(transcription) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a social media trends expert and content strategist. Based on the user's content style, suggest trending topics and personalized video ideas." },
        { role: "user", content: `Based on this video transcription, identify the creator's style and niche. Then provide:\n\n1. 5 TRENDING TOPICS they could cover right now\n2. 5 PERSONALIZED VIDEO IDEAS based on their style\n\nTranscription: ${transcription}` }
      ],
      max_tokens: 600
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating trends:', error);
    return "Trending topics could not be generated at this time.";
  }
}

async function generateTitleAndDescription(transcription) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a YouTube SEO expert. Generate compelling, click-worthy titles and descriptions that rank well in search." },
        { role: "user", content: `Based on this video transcription, generate:\n\n1. 5 TITLE OPTIONS (each under 60 characters, attention-grabbing, SEO-friendly)\n2. 1 DESCRIPTION (2-3 paragraphs with keywords, include a call-to-action)\n\nFormat EXACTLY like this:\nTITLE 1: [title]\nTITLE 2: [title]\nTITLE 3: [title]\nTITLE 4: [title]\nTITLE 5: [title]\n\nDESCRIPTION:\n[description]\n\nTranscription: ${transcription}` }
      ],
      max_tokens: 700
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating title/description:', error);
    return "Title and description could not be generated at this time.";
  }
}

async function generateHashtags(transcription) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a social media hashtag expert. Generate relevant, trending hashtags that will maximize reach and engagement. Format each hashtag on its own line within each section for easy parsing." },
        { role: "user", content: `Based on this video transcription, generate:\n\n1. 10 YOUTUBE HASHTAGS (most relevant for YouTube search)\n2. 15 TIKTOK/INSTAGRAM HASHTAGS (mix of popular and niche)\n3. 5 TRENDING HASHTAGS (currently viral tags that fit this content)\n\nFormat each section clearly with headers. Include the # symbol. Put each hashtag on its own line.\n\nTranscription: ${transcription}` }
      ],
      max_tokens: 400
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating hashtags:', error);
    return "Hashtags could not be generated at this time.";
  }
}

async function generateVideoScore(transcription) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a video content analyst. Score videos objectively and provide actionable feedback. Always return scores as numbers." },
        { role: "user", content: `Analyze this video transcription and provide a detailed score:\n\n1. OVERALL SCORE: [X/100]\n\n2. CATEGORY SCORES (each out of 100):\n- Hook Strength: [score] - [1 sentence explanation]\n- Content Value: [score] - [1 sentence explanation]\n- Engagement Potential: [score] - [1 sentence explanation]\n- Clarity: [score] - [1 sentence explanation]\n- Call-to-Action: [score] - [1 sentence explanation]\n\n3. BIGGEST STRENGTH: [1 sentence]\n4. BIGGEST WEAKNESS: [1 sentence]\n5. #1 IMPROVEMENT: [specific action to take]\n\nBe honest but constructive.\n\nTranscription: ${transcription}` }
      ],
      max_tokens: 500
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating video score:', error);
    return "Video score could not be generated at this time.";
  }
}

async function generateHookAnalysis(transcription) {
  try {
    const first100Words = transcription.split(' ').slice(0, 100).join(' ');
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a viral video hook expert. Analyze the opening of videos and provide specific feedback on how to capture attention in the first 3 seconds." },
        { role: "user", content: `Analyze the opening of this video (first ~100 words):\n\n"${first100Words}"\n\nProvide:\n1. HOOK RATING: [WEAK / AVERAGE / STRONG / VIRAL-WORTHY]\n\n2. WHAT WORKS: [What's good about this opening]\n\n3. WHAT'S MISSING: [What could be better]\n\n4. REWRITTEN HOOK: [Write a better opening hook they could use - 2-3 sentences max]\n\n5. 3 ALTERNATIVE HOOKS: [Give 3 different hook styles they could try]\n\nBe specific and actionable.` }
      ],
      max_tokens: 500
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating hook analysis:', error);
    return "Hook analysis could not be generated at this time.";
  }
}

async function generateThumbnailText(transcription) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a YouTube thumbnail expert who understands what text makes people click. Thumbnail text should be SHORT (1-4 words max), emotionally triggering, and create curiosity or urgency." },
        { role: "user", content: `Based on this video transcription, suggest thumbnail text options:\n\n1. PRIMARY TEXT: [1-3 words - the main eye-catching text]\n2. SECONDARY TEXT: [2-4 words - supporting text if needed]\n3. EMOTION TO CONVEY: [What feeling should the thumbnail evoke]\n4. 5 ALTERNATIVE TEXT OPTIONS: [Different angles/hooks]\n\nRules:\n- Keep text VERY short (thumbnails have limited space)\n- Use power words (FREE, SECRET, STOP, NOW, etc.)\n- Create curiosity gaps\n- Consider using numbers when relevant\n\nTranscription: ${transcription}` }
      ],
      max_tokens: 300
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating thumbnail text:', error);
    return "Thumbnail text suggestions could not be generated at this time.";
  }
}

async function generatePacingAnalysis(transcription) {
  try {
    const wordCount = transcription.split(' ').length;
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a video pacing expert who understands audience retention. Analyze transcripts to identify where viewers might lose interest and how to maintain engagement throughout." },
        { role: "user", content: `Analyze the pacing of this video (${wordCount} words total):\n\n1. PACING RATING: [TOO SLOW / SLIGHTLY SLOW / PERFECT / SLIGHTLY FAST / TOO FAST]\n\n2. ESTIMATED DROP-OFF POINTS: Identify 2-3 spots where viewers might click away and explain why.\n\n3. ENERGY FLOW: Does the energy stay consistent? Where does it dip?\n\n4. PACING FIXES: Give 3 specific suggestions to improve pacing.\n\n5. IDEAL VIDEO LENGTH: Based on the content density, what length would be optimal?\n\nTranscription: ${transcription}` }
      ],
      max_tokens: 400
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating pacing analysis:', error);
    return "Pacing analysis could not be generated at this time.";
  }
}

async function generateCTARecommendations(transcription) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a conversion expert who knows how to get viewers to take action. Analyze videos and suggest the perfect calls-to-action based on the content and audience." },
        { role: "user", content: `Based on this video's content, recommend the best calls-to-action:\n\n1. CURRENT CTA ASSESSMENT: Does this video have a clear CTA? Rate it: [NONE / WEAK / DECENT / STRONG]\n\n2. PRIMARY CTA RECOMMENDATION: What's the ONE thing viewers should do after watching? Give the exact script (2-3 sentences).\n\n3. SECONDARY CTAs: Suggest 2-3 other CTAs that would work (subscribe, comment prompt, share prompt, etc.) with exact wording.\n\n4. CTA PLACEMENT: Where in the video should each CTA go? (beginning, middle, end, throughout)\n\n5. CTA STYLE: What tone works best for this creator? (casual ask, urgent, humor, emotional, etc.)\n\nTranscription: ${transcription}` }
      ],
      max_tokens: 400
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating CTA recommendations:', error);
    return "CTA recommendations could not be generated at this time.";
  }
}

async function generatePlatformFeedback(transcription) {
  try {
    const wordCount = transcription.split(' ').length;
    const estimatedDuration = Math.round(wordCount / 150);
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a multi-platform social media strategist who understands the unique requirements of YouTube, TikTok, Instagram Reels, and LinkedIn. Help creators optimize and repurpose content." },
        { role: "user", content: `This video is approximately ${estimatedDuration} minute(s) long. Analyze it for each platform:\n\n📺 YOUTUBE:\n- Optimization score: [1-10]\n- What works: [1-2 sentences]\n- What to change: [1-2 sentences]\n\n🎵 TIKTOK:\n- Optimization score: [1-10]\n- What works: [1-2 sentences]\n- What to change: [1-2 sentences]\n- Best clip to extract: [Describe which part would work as a TikTok]\n\n📸 INSTAGRAM REELS:\n- Optimization score: [1-10]\n- What works: [1-2 sentences]\n- What to change: [1-2 sentences]\n\n💼 LINKEDIN (if applicable):\n- Would this work on LinkedIn? [YES/NO]\n- If yes, how to adapt it: [1-2 sentences]\n\n🔄 REPURPOSING STRATEGY: How should they slice this content across platforms?\n\nTranscription: ${transcription}` }
      ],
      max_tokens: 500
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating platform feedback:', error);
    return "Platform feedback could not be generated at this time.";
  }
}

async function generateAudioNotes(transcription, segments) {
  try {
    let avgWordsPerMinute = 150;
    let speakingPaceNote = "";
    
    if (segments && segments.length > 0) {
      const totalDuration = segments[segments.length - 1].end - segments[0].start;
      const totalWords = transcription.split(' ').length;
      avgWordsPerMinute = Math.round((totalWords / totalDuration) * 60);
      
      if (avgWordsPerMinute < 120) {
        speakingPaceNote = `Speaking pace: ${avgWordsPerMinute} WPM (SLOW - might lose viewers)`;
      } else if (avgWordsPerMinute < 150) {
        speakingPaceNote = `Speaking pace: ${avgWordsPerMinute} WPM (Good - conversational)`;
      } else if (avgWordsPerMinute < 180) {
        speakingPaceNote = `Speaking pace: ${avgWordsPerMinute} WPM (Good - energetic)`;
      } else {
        speakingPaceNote = `Speaking pace: ${avgWordsPerMinute} WPM (FAST - might be hard to follow)`;
      }
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an audio/speech coach who helps creators improve their vocal delivery. Analyze transcripts for speech patterns, filler words, and delivery issues." },
        { role: "user", content: `Analyze the audio/speech quality based on this transcription:\n\n${speakingPaceNote}\n\n1. FILLER WORDS DETECTED: List any filler words found (um, uh, like, you know, basically, actually, so, right) and their approximate frequency.\n\n2. SPEECH CLARITY: [EXCELLENT / GOOD / NEEDS WORK] - Are sentences complete? Is there rambling?\n\n3. ENERGY/TONE: Does the speaker sound: [Monotone / Low energy / Conversational / Energetic / Over-the-top]?\n\n4. VOCAL VARIETY: Is there enough variation in pitch and pace to keep listeners engaged?\n\n5. TOP 3 AUDIO IMPROVEMENTS: Specific, actionable tips to improve vocal delivery.\n\nNote: This analysis is based on the transcript text, not actual audio quality (background noise, mic quality, etc.).\n\nTranscription: ${transcription}` }
      ],
      max_tokens: 400
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating audio notes:', error);
    return "Audio notes could not be generated at this time.";
  }
}

// ============================================
// COMPETITOR ANALYSIS FUNCTIONS
// ============================================

async function analyzeCompetitorSuccess(transcription) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a viral video analyst who studies successful content to understand what makes it work. Be specific and actionable." },
        { role: "user", content: `Analyze this successful video and identify WHY it works:\n\n1. TOP 5 SUCCESS FACTORS: What specifically makes this video engaging? (Be concrete, not generic)\n\n2. CONTENT HOOKS USED: List every hook/attention-grabber you can identify\n\n3. EMOTIONAL TRIGGERS: What emotions does this video tap into?\n\n4. UNIQUE ANGLE: What makes this video different from others on the same topic?\n\n5. SHAREABILITY SCORE: [1-10] Why would someone share this?\n\nTranscription: ${transcription}` }
      ],
      max_tokens: 600
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error analyzing competitor success:', error);
    return "Success analysis could not be generated at this time.";
  }
}

async function analyzeCompetitorStructure(transcription) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a content strategist who reverse-engineers successful video structures." },
        { role: "user", content: `Break down the STRUCTURE of this video:\n\n1. OPENING (First 30 seconds): How do they hook viewers? What technique?\n\n2. CONTENT FLOW: List the main sections/segments in order with timestamps estimates\n\n3. PACING PATTERN: How do they maintain energy? When do they speed up/slow down?\n\n4. TRANSITION TECHNIQUES: How do they move between topics?\n\n5. CLOSING STRATEGY: How do they end? What CTA do they use?\n\n6. STRUCTURE TEMPLATE: Write a reusable outline based on this video's structure\n\nTranscription: ${transcription}` }
      ],
      max_tokens: 600
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error analyzing competitor structure:', error);
    return "Structure analysis could not be generated at this time.";
  }
}

async function analyzeCompetitorTactics(transcription) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a content coach helping creators learn from successful competitors. Focus on actionable tactics they can apply to their own videos." },
        { role: "user", content: `Identify WINNING TACTICS from this video:\n\n🎯 HOOKS TO USE:\nList 3 specific hooks or phrases you could adapt\n\n🗣️ SPEAKING TECHNIQUES:\nWhat vocal/delivery techniques make this engaging?\n\n📝 SCRIPT PATTERNS:\nAny repeatable script formulas or patterns?\n\n💡 CONTENT IDEAS SPARKED:\nWhat 3 video ideas does this inspire?\n\n⚠️ WHAT TO AVOID:\nAnything in this video that doesn't work or you shouldn't copy?\n\n📋 ACTION ITEMS:\nList 5 specific things to implement in your next video based on this analysis\n\nTranscription: ${transcription}` }
      ],
      max_tokens: 600
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error analyzing competitor tactics:', error);
    return "Tactics analysis could not be generated at this time.";
  }
}

async function analyzeCompetitorSEO(transcription) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a YouTube SEO expert who can identify ranking factors from video content." },
        { role: "user", content: `Analyze the SEO/discoverability factors in this video:\n\n1. KEYWORDS DETECTED: What keywords/phrases are naturally mentioned that help with search?\n\n2. TOPIC RELEVANCE: How well does this video match likely search intent?\n\n3. SUGGESTED TITLE: Based on content, what title would work well? Give 3 options.\n\n4. SUGGESTED DESCRIPTION: Write an SEO-optimized description for this video\n\n5. HASHTAGS: 15 relevant hashtags based on the content\n\n6. WHY IT MIGHT RANK: What factors suggest this video would perform well in search/suggested?\n\nTranscription: ${transcription}` }
      ],
      max_tokens: 500
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error analyzing competitor SEO:', error);
    return "SEO analysis could not be generated at this time.";
  }
}

async function generateCompetitorSummary(transcription) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a video analyst. Provide brief, punchy summaries." },
        { role: "user", content: `In 2-3 sentences, summarize what this video is about and its main value proposition:\n\nTranscription: ${transcription.substring(0, 1000)}` }
      ],
      max_tokens: 100
    });
    return response.choices[0].message.content;
  } catch (error) {
    return "Competitor video analysis";
  }
}

// Generate a short summary for history storage
async function generateQuickSummary(transcription) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a video content summarizer. Create very brief summaries." },
        { role: "user", content: `In 1-2 sentences (max 100 characters), what is this video about?\n\nTranscription: ${transcription.substring(0, 500)}` }
      ],
      max_tokens: 50
    });
    return response.choices[0].message.content;
  } catch (error) {
    return "Video analysis";
  }
}

// ============================================
// TRANSCRIPTION ENDPOINTS
// ============================================

app.post('/api/transcribe', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    const filePath = req.file.path;
    const fileName = req.file.originalname || 'Uploaded Video';
    
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
      response_format: "verbose_json"
    });
    fs.unlinkSync(filePath);
    
    // Run all analyses in parallel
    const [tips, trendingAndIdeas, titleAndDescription, hashtags, videoScore, hookAnalysis, thumbnailText, pacingAnalysis, ctaRecommendations, platformFeedback, audioNotes, quickSummary] = await Promise.all([
      generateVideoTips(transcription.text),
      generateTrendingAndIdeas(transcription.text),
      generateTitleAndDescription(transcription.text),
      generateHashtags(transcription.text),
      generateVideoScore(transcription.text),
      generateHookAnalysis(transcription.text),
      generateThumbnailText(transcription.text),
      generatePacingAnalysis(transcription.text),
      generateCTARecommendations(transcription.text),
      generatePlatformFeedback(transcription.text),
      generateAudioNotes(transcription.text, transcription.segments),
      generateQuickSummary(transcription.text)
    ]);
    
    // Calculate benchmarking
    const overallScore = extractOverallScore(videoScore);
    let percentile = null;
    if (overallScore) {
      percentile = calculatePercentile(overallScore);
      addScoreToHistory(overallScore);
    }
    
    res.json({
      success: true,
      text: transcription.text,
      segments: transcription.segments,
      tips,
      trendingAndIdeas,
      titleAndDescription,
      hashtags,
      videoScore,
      hookAnalysis,
      thumbnailText,
      pacingAnalysis,
      ctaRecommendations,
      platformFeedback,
      audioNotes,
      percentile,
      totalVideosAnalyzed: globalStats.totalVideosAnalyzed,
      // For history storage
      videoTitle: fileName,
      videoSource: 'upload',
      overallScore,
      quickSummary
    });
  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/transcribe-youtube', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'No URL provided' });
    }
    
    const videoId = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&\s?]+)/)?.[1];
    if (!videoId) {
      return res.status(400).json({ success: false, error: 'Invalid YouTube URL' });
    }
    
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    // Ensure uploads directory exists
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir);
    }
    
    const audioPath = path.join(uploadsDir, `${videoId}.mp3`);
    
    // Get video title first
    let videoTitle = 'YouTube Video';
    try {
      const { stdout: titleOutput } = await execPromise(`yt-dlp --get-title "${url}"`);
      videoTitle = titleOutput.trim() || 'YouTube Video';
    } catch (e) {
      console.log('Could not fetch video title:', e.message);
    }
    
    // Download audio using yt-dlp
    console.log('Downloading audio with yt-dlp...');
    try {
      await execPromise(`yt-dlp -x --audio-format mp3 --audio-quality 9 -o "${audioPath}" "${url}"`);
    } catch (downloadError) {
      console.error('yt-dlp download failed:', downloadError.message);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to download video. YouTube may be blocking this video. Try uploading the video file directly instead.' 
      });
    }
    
    // Check if file was created
    if (!fs.existsSync(audioPath)) {
      return res.status(500).json({ success: false, error: 'Audio file was not created. Try uploading the video file directly.' });
    }
    
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
      response_format: "verbose_json"
    });
    fs.unlinkSync(audioPath);
    
    // Run all analyses in parallel
    const [tips, trendingAndIdeas, titleAndDescription, hashtags, videoScore, hookAnalysis, thumbnailText, pacingAnalysis, ctaRecommendations, platformFeedback, audioNotes, quickSummary] = await Promise.all([
      generateVideoTips(transcription.text),
      generateTrendingAndIdeas(transcription.text),
      generateTitleAndDescription(transcription.text),
      generateHashtags(transcription.text),
      generateVideoScore(transcription.text),
      generateHookAnalysis(transcription.text),
      generateThumbnailText(transcription.text),
      generatePacingAnalysis(transcription.text),
      generateCTARecommendations(transcription.text),
      generatePlatformFeedback(transcription.text),
      generateAudioNotes(transcription.text, transcription.segments),
      generateQuickSummary(transcription.text)
    ]);
    
    // Calculate benchmarking
    const overallScore = extractOverallScore(videoScore);
    let percentile = null;
    if (overallScore) {
      percentile = calculatePercentile(overallScore);
      addScoreToHistory(overallScore);
    }
    
    res.json({
      success: true,
      text: transcription.text,
      segments: transcription.segments,
      tips,
      trendingAndIdeas,
      titleAndDescription,
      hashtags,
      videoScore,
      hookAnalysis,
      thumbnailText,
      pacingAnalysis,
      ctaRecommendations,
      platformFeedback,
      audioNotes,
      percentile,
      totalVideosAnalyzed: globalStats.totalVideosAnalyzed,
      // For history storage
      videoTitle,
      videoUrl: url,
      videoSource: 'youtube',
      overallScore,
      quickSummary
    });
  } catch (error) {
    console.error('YouTube transcription error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// COMPETITOR ANALYSIS ENDPOINT
// ============================================

app.post('/api/analyze-competitor', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'No URL provided' });
    }
    
    const videoId = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&\s?]+)/)?.[1];
    if (!videoId) {
      return res.status(400).json({ success: false, error: 'Invalid YouTube URL' });
    }
    
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    // Ensure uploads directory exists
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir);
    }
    
    const audioPath = path.join(uploadsDir, `comp_${videoId}.mp3`);
    
    // Get video title first
    let videoTitle = 'Competitor Video';
    try {
      const { stdout: titleOutput } = await execPromise(`yt-dlp --get-title "${url}"`);
      videoTitle = titleOutput.trim() || 'Competitor Video';
    } catch (e) {
      console.log('Could not fetch video title:', e.message);
    }
    
    // Download audio using yt-dlp
    console.log('Downloading competitor audio with yt-dlp...');
    try {
      await execPromise(`yt-dlp -x --audio-format mp3 --audio-quality 9 -o "${audioPath}" "${url}"`);
    } catch (downloadError) {
      console.error('yt-dlp download failed:', downloadError.message);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to download video. YouTube may be blocking this video.' 
      });
    }
    
    // Check if file was created
    if (!fs.existsSync(audioPath)) {
      return res.status(500).json({ success: false, error: 'Audio file was not created.' });
    }
    
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
      response_format: "verbose_json"
    });
    fs.unlinkSync(audioPath);
    
    // Run competitor-specific analyses in parallel
    const [successAnalysis, structureAnalysis, tacticsAnalysis, seoAnalysis, competitorSummary] = await Promise.all([
      analyzeCompetitorSuccess(transcription.text),
      analyzeCompetitorStructure(transcription.text),
      analyzeCompetitorTactics(transcription.text),
      analyzeCompetitorSEO(transcription.text),
      generateCompetitorSummary(transcription.text)
    ]);
    
    res.json({
      success: true,
      isCompetitorAnalysis: true,
      text: transcription.text,
      videoTitle,
      videoUrl: url,
      successAnalysis,
      structureAnalysis,
      tacticsAnalysis,
      seoAnalysis,
      competitorSummary
    });
  } catch (error) {
    console.error('Competitor analysis error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// GLOBAL STATS ENDPOINT
// ============================================

app.get('/api/stats', (req, res) => {
  res.json({
    totalVideosAnalyzed: globalStats.totalVideosAnalyzed,
    averageScore: globalStats.scoreHistory.length > 0 
      ? Math.round(globalStats.scoreHistory.reduce((a, b) => a + b, 0) / globalStats.scoreHistory.length)
      : 0
  });
});

// ============================================
// TRENDING VIDEOS ENDPOINT
// ============================================

// Cache for trending videos (refresh every 30 minutes)
let trendingCache = {
  data: null,
  lastFetch: null
};

const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

app.get('/api/trending', async (req, res) => {
  try {
    const { category } = req.query;
    
    // Check cache
    const cacheKey = category || 'all';
    if (trendingCache.data && 
        trendingCache.data[cacheKey] && 
        trendingCache.lastFetch && 
        (Date.now() - trendingCache.lastFetch) < CACHE_DURATION) {
      return res.json({ success: true, videos: trendingCache.data[cacheKey], cached: true });
    }
    
    // Category IDs for YouTube
    const categoryIds = {
      'gaming': '20',
      'music': '10',
      'entertainment': '24',
      'howto': '26',
      'science': '28',
      'sports': '17',
      'news': '25',
      'comedy': '23',
      'education': '27',
      'tech': '28'
    };
    
    let apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=US&maxResults=12&key=${YOUTUBE_API_KEY}`;
    
    if (category && categoryIds[category]) {
      apiUrl += `&videoCategoryId=${categoryIds[category]}`;
    }
    
    const response = await fetch(apiUrl);
    const data = await response.json();
    
    if (data.error) {
      console.error('YouTube API error:', data.error);
      return res.status(500).json({ success: false, error: data.error.message });
    }
    
    // Format the videos
    const videos = data.items.map(video => ({
      id: video.id,
      title: video.snippet.title,
      thumbnail: video.snippet.thumbnails.high?.url || video.snippet.thumbnails.medium?.url,
      channel: video.snippet.channelTitle,
      views: formatViews(video.statistics.viewCount),
      viewCount: parseInt(video.statistics.viewCount),
      likes: video.statistics.likeCount,
      publishedAt: video.snippet.publishedAt,
      url: `https://www.youtube.com/watch?v=${video.id}`
    }));
    
    // Update cache
    if (!trendingCache.data) trendingCache.data = {};
    trendingCache.data[cacheKey] = videos;
    trendingCache.lastFetch = Date.now();
    
    res.json({ success: true, videos, cached: false });
  } catch (error) {
    console.error('Trending videos error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper function to format view counts
function formatViews(views) {
  const num = parseInt(views);
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
