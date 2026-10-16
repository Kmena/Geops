package com.geops.weekendpoc

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase

@Entity(tableName = "pending_location")
data class PendingLocation(
    @PrimaryKey val eventId: String,
    val deviceId: String,
    val capturedAt: String,
    val encryptedPayload: String,
    val ackAt: Long? = null
)

@Dao
interface LocationDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insert(item: PendingLocation)
    @Query("SELECT * FROM pending_location WHERE ackAt IS NULL AND deviceId = :deviceId ORDER BY capturedAt,eventId LIMIT 50")
    fun pending(deviceId: String): List<PendingLocation>
    @Query("SELECT COUNT(*) FROM pending_location WHERE ackAt IS NULL")
    fun pendingCount(): Int
    @Query("SELECT COUNT(*) FROM pending_location WHERE ackAt IS NULL AND deviceId = :deviceId")
    fun pendingCountForDevice(deviceId: String): Int
    @Query("SELECT * FROM pending_location WHERE deviceId = :deviceId ORDER BY capturedAt DESC LIMIT 1")
    fun latest(deviceId: String): PendingLocation?
    @Query("UPDATE pending_location SET ackAt = :time WHERE eventId IN (:ids)")
    fun acknowledge(ids: List<String>, time: Long)
    @Query("DELETE FROM pending_location WHERE ackAt IS NOT NULL")
    fun removeAcknowledged()
}

@Database(entities = [PendingLocation::class], version = 1, exportSchema = false)
abstract class LocationDatabase : RoomDatabase() {
    abstract fun locations(): LocationDao
    companion object {
        @Volatile private var instance: LocationDatabase? = null
        fun get(context: Context): LocationDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(context.applicationContext, LocationDatabase::class.java, "poc-buffer")
                    .build().also { instance = it }
            }
    }
}
