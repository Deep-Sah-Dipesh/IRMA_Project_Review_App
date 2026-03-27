import React, { useEffect, useState } from 'react';
import { View, Text, Modal, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import * as Updates from 'expo-updates';

export default function UpdateHandler() {
  const { isUpdateAvailable, isUpdatePending } = Updates.useUpdates();
  const [status, setStatus] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);

  useEffect(() => {
    // 1. Trigger Check Immediately on Mount
    if (!__DEV__) {
      handleUpdateCheck();
    }
  }, []);

  const handleUpdateCheck = async () => {
    try {
      setStatus('Checking for updates...');
      const update = await Updates.checkForUpdateAsync();
      
      if (update.isAvailable) {
        setIsDownloading(true);
        setStatus('Downloading new version...');
        await Updates.fetchUpdateAsync();
        setStatus('Update ready!');
      }
    } catch (error) {
      console.error("Update Error:", error);
      setIsDownloading(false);
    }
  };

  // If a download is finished and waiting to be applied
  const showModal = isDownloading || isUpdatePending;

  return (
    <Modal visible={showModal} transparent animationType="fade">
      <View style={styles.overlay}>
        <View style={styles.alertBox}>
          <Text style={styles.title}>System Update</Text>
          
          <ActivityIndicator 
            size="large" 
            color="#2196F3" 
            animating={!isUpdatePending} 
          />
          
          <Text style={styles.message}>{status}</Text>

          {isUpdatePending && (
            <TouchableOpacity 
              style={styles.button} 
              onPress={() => Updates.reloadAsync()}
            >
              <Text style={styles.buttonText}>Restart to Apply</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  alertBox: {
    width: '80%',
    backgroundColor: 'white',
    padding: 30,
    borderRadius: 15,
    alignItems: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  message: {
    fontSize: 16,
    marginVertical: 20,
    textAlign: 'center',
    color: '#666',
  },
  button: {
    backgroundColor: '#2196F3',
    paddingHorizontal: 30,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    color: 'white',
    fontWeight: 'bold',
  },
});