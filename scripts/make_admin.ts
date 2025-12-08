
import { db } from "../server/db";
import { users } from "@shared/schema-sqlite";
import { eq } from "drizzle-orm";
import { hashPassword } from "../server/auth"; // Assuming this helper exists, otherwise I'll use bcryptjs directly
import bcrypt from "bcryptjs";

async function makeAdmin(email: string) {
    console.log(`Checking for user with email: ${email}`);

    const user = await db.select().from(users).where(eq(users.email, email)).get();

    if (user) {
        console.log(`User found: ${user.username} (${user.id})`);
        console.log(`Current role: ${user.role}`);

        if (user.role === 'admin') {
            console.log('User is already an admin.');
            return;
        }

        await db.update(users)
            .set({ role: 'admin' })
            .where(eq(users.id, user.id));

        console.log(`Successfully updated role to admin for user: ${email}`);
    } else {
        console.log(`User not found. Creating new admin user for: ${email}`);
        const hashedPassword = await bcrypt.hash("password123", 10);

        // Generate a username from email
        const username = email.split('@')[0];

        await db.insert(users).values({
            email,
            username,
            password: hashedPassword,
            role: 'admin',
            isEmailVerified: true,
            plan: 'pro', // Give them pro plan too since they are admin
        });

        console.log(`Created new admin user: ${email} with password: password123`);
    }
}

const email = "gwal325@gmail.com";
makeAdmin(email)
    .then(() => {
        console.log("Done");
        process.exit(0);
    })
    .catch((err) => {
        console.error("Error:", err);
        process.exit(1);
    });
