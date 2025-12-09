
import 'dotenv/config';
import { storage } from "../server/storage";

async function listStories() {
    console.log("Listing stories...");
    // We need a user ID to fetch stories, or we can just use a raw query if storage doesn't have a 'getAllStories'
    // storage.getStoriesForUser requires a userId.
    // Let's try to find the admin user first.
    const user = await storage.getUserByEmail("gwal325@gmail.com");
    if (!user) {
        console.log("Admin user not found.");
        return;
    }

    const stories = await storage.getStoriesForUser(user.id);
    console.log(`Found ${stories.length} stories:`);
    stories.forEach(s => console.log(`- ${s.title} (${s.category})`));
}

listStories().catch(console.error);
