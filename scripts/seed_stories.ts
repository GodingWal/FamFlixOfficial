
import 'dotenv/config';
import { storage } from "../server/storage";

async function seedStories() {
    console.log("Seeding stories...");

    const user = await storage.getUserByEmail("gwal325@gmail.com");
    if (!user) {
        console.error("User not found");
        return;
    }
    console.log(`User found: ${user.email} (${user.id})`);

    const stories = [
        {
            title: "The Little Astronaut",
            author: "FamFlix AI",
            category: "ADVENTURE",
            ageMin: 4,
            ageMax: 8,
            tags: ["space", "stars", "dream"],
            durationMin: 5,
            content: "Once upon a time, there was a little astronaut named Leo. Leo loved the stars...",
            summary: "Leo travels to the moon and meets a friendly alien.",
            createdBy: user.id,
            status: "generated",
            coverUrl: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=800&q=80",
        },
        {
            title: "The Sleepy Bear",
            author: "FamFlix AI",
            category: "BEDTIME",
            ageMin: 2,
            ageMax: 5,
            tags: ["animals", "forest", "sleep"],
            durationMin: 3,
            content: "Deep in the forest, a big brown bear was getting ready for his winter nap...",
            summary: "A gentle story about a bear preparing for hibernation.",
            createdBy: user.id,
            status: "generated",
            coverUrl: "https://images.unsplash.com/photo-1589656966895-2f33e7653819?w=800&q=80",
        },
        {
            title: "The Magic Garden",
            author: "FamFlix AI",
            category: "FAIRYTALE",
            ageMin: 5,
            ageMax: 9,
            tags: ["magic", "flowers", "fairies"],
            durationMin: 7,
            content: "In a hidden corner of the world, there was a garden where the flowers could sing...",
            summary: "Lily discovers a secret garden full of magical plants.",
            createdBy: user.id,
            status: "generated",
            coverUrl: "https://images.unsplash.com/photo-1585320806297-9794b3e4eeae?w=800&q=80",
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

seedStories().catch(console.error);
