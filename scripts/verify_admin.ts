
import { db } from "../server/db";
import { users } from "@shared/schema-sqlite";
import { eq } from "drizzle-orm";

async function verifyAdmin(email: string) {
    const user = await db.select().from(users).where(eq(users.email, email)).get();
    if (user) {
        console.log(`User: ${user.email}, Role: ${user.role}`);
    } else {
        console.log("User not found");
    }
}

verifyAdmin("gwal325@gmail.com");
