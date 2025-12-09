
import 'dotenv/config';
import { storage } from "../server/storage";
import { createServer } from "http";
import express from "express";

// We can't easily test the API via HTTP without a token, 
// but we can verify the storage method returns what we expect 
// and that the route logic (which we manually verified by reading code) matches.
// Actually, let's just verify the storage method works as expected first.

async function verifyStories() {
    console.log("Verifying stories...");

    const user = await storage.getUserByEmail("gwal325@gmail.com");
    if (!user) {
        console.error("User not found");
        return;
    }

    // Test searchStories
    const results = await storage.searchStories({ limit: 10 });
    console.log(`searchStories returned ${results.total} total stories.`);

    if (results.items.length > 0) {
        console.log("First story:", results.items[0].title);
    } else {
        console.warn("No stories found via searchStories.");
    }

    // Test getStoriesForUser
    const userStories = await storage.getStoriesForUser(user.id);
    console.log(`getStoriesForUser returned ${userStories.length} stories.`);

    console.log("Verification complete.");
}

verifyStories().catch(console.error);
