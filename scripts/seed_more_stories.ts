
import 'dotenv/config';
import { storage } from "../server/storage";

async function seedMoreStories() {
    console.log("Seeding MORE stories...");

    const user = await storage.getUserByEmail("gwal325@gmail.com");
    if (!user) {
        console.error("User not found");
        return;
    }

    const stories = [
        {
            title: "The Brave Knight",
            author: "FamFlix AI",
            category: "ADVENTURE",
            ageMin: 6,
            ageMax: 10,
            tags: ["dragons", "castles", "bravery"],
            durationMin: 8,
            content: "Sir Arthur was the bravest knight in the kingdom. One day, a friendly dragon asked for help...",
            summary: "Sir Arthur helps a dragon find its lost treasure.",
            createdBy: user.id,
            status: "generated",
            coverUrl: "https://images.unsplash.com/photo-1599058945522-28d584b6f0ff?w=800&q=80",
        },
        {
            title: "The Curious Cat",
            author: "FamFlix AI",
            category: "EDUCATIONAL",
            ageMin: 3,
            ageMax: 6,
            tags: ["animals", "learning", "curiosity"],
            durationMin: 4,
            content: "Whiskers the cat was very curious. 'Why is the sky blue?' she asked the wise old owl...",
            summary: "Whiskers learns about the world around her.",
            createdBy: user.id,
            status: "generated",
            coverUrl: "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=800&q=80",
        },
        {
            title: "The Lost Puppy",
            author: "FamFlix AI",
            category: "BEDTIME",
            ageMin: 2,
            ageMax: 5,
            tags: ["animals", "friendship", "home"],
            durationMin: 5,
            content: "Spot was a tiny puppy with big spots. He ran too far chasing a butterfly...",
            summary: "Spot finds his way home with the help of new friends.",
            createdBy: user.id,
            status: "generated",
            coverUrl: "https://images.unsplash.com/photo-1543466835-00a7907e9de1?w=800&q=80",
        }
    ];

    for (const story of stories) {
        try {
            await storage.createStory(story as any);
            console.log(`Created story: ${story.title}`);
        } catch (error) {
            console.error(`Failed to create story ${story.title}:`, error);
        }
    }

    console.log("Seeding complete.");
}

seedMoreStories().catch(console.error);
