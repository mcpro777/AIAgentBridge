package com.agentbridge.android.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "conversations")
data class ConversationRow(
    @androidx.room.PrimaryKey val id: String,
    val title: String,
    val updatedAt: String
)

data class PairedDevice(
    val id: String,
    val name: String,
    val createdAt: String,
    val lastSeenAt: String
)

@Entity(
    tableName = "events",
    primaryKeys = ["conversationId", "sequence"]
)
data class EventRow(
    val conversationId: String,
    val sequence: Long,
    val type: String,
    val payload: String
)

@Dao
interface BridgeDao {
    @Query("SELECT * FROM conversations ORDER BY updatedAt DESC")
    fun observeConversations(): Flow<List<ConversationRow>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveConversations(conversations: List<ConversationRow>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveConversation(conversation: ConversationRow)

    @Query("SELECT * FROM events WHERE conversationId = :conversationId ORDER BY sequence")
    fun observeEvents(conversationId: String): Flow<List<EventRow>>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun saveEvent(event: EventRow): Long

    @Query("SELECT COALESCE(MAX(sequence), 0) FROM events WHERE conversationId = :conversationId")
    suspend fun lastSequence(conversationId: String): Long

    @Query("SELECT id FROM conversations")
    suspend fun conversationIds(): List<String>

    @Query("DELETE FROM events")
    suspend fun clearEvents()

    @Query("DELETE FROM events WHERE conversationId = :conversationId")
    suspend fun deleteConversationEvents(conversationId: String)

    @Query("DELETE FROM conversations WHERE id = :conversationId")
    suspend fun deleteConversationRow(conversationId: String)

    @Query("DELETE FROM events WHERE conversationId NOT IN (:conversationIds)")
    suspend fun deleteEventsOutsideConversationList(conversationIds: List<String>)

    @Query("DELETE FROM conversations WHERE id NOT IN (:conversationIds)")
    suspend fun deleteConversationsOutsideList(conversationIds: List<String>)

    @Transaction
    suspend fun deleteConversation(conversationId: String) {
        deleteConversationEvents(conversationId)
        deleteConversationRow(conversationId)
    }

    @Transaction
    suspend fun synchronizeConversations(conversations: List<ConversationRow>) {
        val ids = conversations.map { it.id }
        if (ids.isEmpty()) {
            clearEvents()
            clearConversations()
        } else {
            deleteEventsOutsideConversationList(ids)
            deleteConversationsOutsideList(ids)
        }
        saveConversations(conversations)
    }

    @Query("DELETE FROM conversations")
    suspend fun clearConversations()
}

@Database(entities = [ConversationRow::class, EventRow::class], version = 1, exportSchema = false)
abstract class BridgeDatabase : RoomDatabase() {
    abstract fun bridgeDao(): BridgeDao

    companion object {
        fun create(context: Context, name: String = "agentbridge.db"): BridgeDatabase =
            Room.databaseBuilder(context, BridgeDatabase::class.java, name).build()
    }
}
