package com.dnkdialer.companion

import android.content.Context
import android.provider.ContactsContract

data class Contact(
    val id: String,
    val name: String,
    val number: String
)

class ContactsHandler(private val context: Context) {

    fun getContacts(): List<Contact> {
        val contacts = mutableListOf<Contact>()

        try {
            val cursor = context.contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(
                    ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER
                ),
                null,
                null,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC"
            )

            cursor?.use {
                while (it.moveToNext()) {
                    val id = it.getString(0) ?: continue
                    val name = it.getString(1) ?: "Unknown"
                    // Use empty string for null numbers so contacts without phone numbers
                    // still appear in the list (instead of being silently dropped).
                    val number = it.getString(2) ?: ""

                    contacts.add(Contact(id, name, number))
                }
            }
        } catch (e: SecurityException) {
            android.util.Log.e("ContactsHandler", "READ_CONTACTS permission not granted", e)
            return emptyList()
        }

        // Dedupe only true duplicates (same contact ID AND same number). Different contacts
        // that share a phone number (e.g. work + personal entries pointing at the same line)
        // must both survive.
        val result = contacts.distinctBy { "${it.id}_${it.number}" }
        android.util.Log.d("ContactsHandler", "getContacts() returned ${result.size} contacts")
        return result
    }
}
