import { db } from "../server/db";
import { users } from "@shared/schema";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";

async function resetAdmin() {
    const email = process.argv[2];
    const password = process.argv[3];
    
    if (!email || !password) {
        console.error("Usage: npx tsx scripts/reset-admin.ts <new-email> <new-password>");
        process.exit(1);
    }
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Get the first user (assuming it's the admin)
        const allUsers = await db.select().from(users).limit(1);
        if (allUsers.length === 0) {
             console.error("No users found in database.");
             process.exit(1);
        }
        const admin = allUsers[0];

        await db.update(users)
            .set({ email, password: hashedPassword })
            .where(eq(users.id, admin.id));
            
        console.log(`\n✅ Admin credentials updated successfully!`);
        console.log(`👤 New Email: ${email}`);
        console.log(`🔑 New Password: ${password}\n`);
        
        process.exit(0);
    } catch (error) {
        console.error("Error updating admin credentials:", error);
        process.exit(1);
    }
}

resetAdmin();
