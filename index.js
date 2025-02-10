import express from "express";
import { Client, iteratePaginatedAPI } from "@notionhq/client";
import { config } from "dotenv";
import sqlite3 from "sqlite3";

config();

const app = express();
const port = 3000;

const databaseId = process.env.NOTION_DATABASE_ID;
const apiKey = process.env.NOTION_API_KEY;

const notion = new Client({ auth: apiKey });

// Initialize SQLite Database
const db = new sqlite3.Database("notion.db", (err) => {
  if (err) {
    console.error("Error opening SQLite database:", err.message);
  } else {
    db.run(
      `CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        last_edited_time DATETIME,
        word_count INTEGER
      )`,
      (err) => {
        if (err) {
          console.error("Error creating table:", err.message);
        } else {
          console.log("SQLite database initialized.");
        }
      }
    );
  }
});

// Initialize WordCount History Database
const wordCountDb = new sqlite3.Database("wordcount.db", (err) => {
  if (err) {
    console.error("Error opening WordCount history database:", err.message);
  } else {
    wordCountDb.run(
      `CREATE TABLE IF NOT EXISTS word_count_history (
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        total_words INTEGER
      )`,
      (err) => {
        if (err) {
          console.error("Error creating word count history table:", err.message);
        } else {
          console.log("WordCount history database initialized.");
        }
      }
    );
  }
});

// Function to fetch last edited time from SQLite
const getStoredLastEditedTime = (pageId) => {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT last_edited_time FROM pages WHERE id = ?`,
      [pageId],
      (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? row.last_edited_time : null);
        }
      }
    );
  });
};

// Function to update SQLite database
const updateSQLiteDatabase = (pageId, lastEditedTime, wordCount) => {
  db.run(
    `INSERT INTO pages (id, last_edited_time, word_count)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
     last_edited_time = excluded.last_edited_time,
     word_count = excluded.word_count`,
    [pageId, lastEditedTime, wordCount],
    (err) => {
      if (err) {
        console.error(`Failed to update SQLite database for page ${pageId}:`, err.message);
      } else {
        // console.log(`SQLite database updated for page ${pageId}`);
      }
    }
  );
};

// Your existing code remains unchanged below
const getPlainTextFromRichText = (richText) => {
  return richText.map((t) => t.plain_text).join("");
};

const getTextFromBlock = (block) => {
  let text = "";

  if (block[block.type]?.rich_text) {
    text = getPlainTextFromRichText(block[block.type].rich_text);
  } else {
    switch (block.type) {
      case "bookmark":
        text = block.bookmark.url;
        break;
      case "child_page":
        text = `[Sub-page: ${block.child_page.title}]`;
        break;
      case "embed":
      case "video":
      case "file":
      case "image":
      case "pdf":
        text = "[Media Block]";
        break;
      case "equation":
        text = block.equation.expression;
        break;
      case "link_preview":
        text = block.link_preview.url;
        break;
      default:
        text = "[Unsupported or non-text block]";
        break;
    }
  }

  if (block.has_children) {
    text += " (Has children)";
  }

  return text;
};

async function retrieveBlockChildren(id) {
  const blocks = [];
  for await (const block of iteratePaginatedAPI(notion.blocks.children.list, {
    block_id: id,
  })) {
    blocks.push(block);

    // Recursively fetch children if they exist
    if (block.has_children) {
      const childBlocks = await retrieveBlockChildren(block.id);
      blocks.push(...childBlocks);
    }
  }
  return blocks;
}

const countWordsInText = (text) => {
  if (!text) return 0;

  const matches = text.match(/[\p{L}\p{N}\p{Emoji_Presentation}]+/gu);
  return matches ? matches.length : 0;
};

const countWordsInBlocks = (blocks) => {
  let totalWords = 0;

  for (let block of blocks) {
    const text = getTextFromBlock(block);
    totalWords += countWordsInText(text);
  }

  return totalWords;
};

const updatePageWordCount = async (pageId, wordCount) => {
  try {
    await notion.pages.update({
      page_id: pageId,
      properties: {
        "Word Count": {
          number: wordCount, // Ensure the property type in the database is Number
        },
      },
    });
  } catch (error) {
    console.error(`Failed to update word count for page ${pageId}:`, error.message);
  }
};

// Function to get total word count from notion.db
const getTotalWordCount = () => {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT SUM(word_count) as total FROM pages`,
      [],
      (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? row.total || 0 : 0);
        }
      }
    );
  });
};

// Function to store total word count in wordcount.db
const storeTotalWordCount = (totalWords) => {
  return new Promise((resolve, reject) => {
    wordCountDb.run(
      `INSERT INTO word_count_history (total_words) VALUES (?)`,
      [totalWords],
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
};

const processDatabasePages = async () => {
  try {
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const response = await notion.databases.query({
        database_id: databaseId,
        start_cursor: startCursor, // Pass the cursor for pagination
      });

      const databasePages = response.results;
      hasMore = response.has_more; // Check if there are more pages to fetch
      startCursor = response.next_cursor; // Update cursor for the next batch

      for (const page of databasePages) {
        const pageId = page.id;
        const lastEditedTime = page.last_edited_time;

        // Fetch stored last edited time from SQLite
        const storedLastEditedTime = await getStoredLastEditedTime(pageId);

        // Skip processing if the stored last edited time is more recent or equal
        if (storedLastEditedTime && new Date(lastEditedTime) <= new Date(storedLastEditedTime)) {
          console.log(`Already crawled: ${page.url}`);
          continue; // Skip API interaction
        }

        // Fetch block details and count words only if the page is updated
        const blocks = await retrieveBlockChildren(pageId);
        const wordCount = countWordsInBlocks(blocks);

        // Update Word Count for the page in Notion
        await updatePageWordCount(pageId, wordCount);
        console.log(`Word count updated for page ID: ${page.url}`);

        // Fetch the updated last edited time after modifying the page
        const updatedPage = await notion.pages.retrieve({ page_id: pageId });
        const updatedLastEditedTime = updatedPage.last_edited_time;

        // Update SQLite database with the new last edited time and word count
        updateSQLiteDatabase(pageId, updatedLastEditedTime, wordCount);

        // console.log(`Processed page ID: ${pageId}`);
      }
    }
    // After processing all pages, calculate and store total word count
    const totalWords = await getTotalWordCount();
    await storeTotalWordCount(totalWords);
    console.log(`Total word count (${totalWords}) stored in history database`);
  } catch (error) {
    console.error("Failed to process database pages:", error.message);
  }
};

// Route to process database and update Word Count and SQLite
app.get("/update_word_count", async (req, res) => {
  try {
    await processDatabasePages();
    res.json({ message: "Word count updated and stored in SQLite for all database pages." });
  } catch (error) {
    res.status(500).json({ error: "Failed to update word count." });
  }
});

// Start the Express server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});