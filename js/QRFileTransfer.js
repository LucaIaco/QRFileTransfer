/**
 * @fileoverview
 * - QRFileTransfer namespace contains all the classes needed to make the tool to work
 * - this library depends on the library 'qrcode.js' and 'jsQR.js'. Refer to https://github.com/davidshimjs/qrcodejs and https://github.com/cozmo/jsQR
 * 
 * @author Copyright (c) 2020 Luca Iaconis. All rights reserved.
 */

var QRFileTransfer = {};

/**
 * Core class implementation
 */
QRFileTransfer.Core = class {

    /**
     * Currently displayed view on the screen
     */
    static #displayedView = null;

    /**
     * Reference to the callback called when the user, in Sender mode, picks a file from the input type file
     */
    static #onFileChanged = null;

    /**
     * Reference to the fileworker which is processing the file
     */
    static #fileWorker = null;

    /**
     * Indicates if the Sender/Receiver is currently running
     */
    static #isRunning = false;

    /**
     * The date time value carried by the last received QR Code. this is needed in order to prevent the processing of the same qr code multiple time
     * in case the Camera is processing the same QR Code.
     */
    static #lastReceivedDatetime = null;

    /**
     * The Sender/Receiver Datetime when the process started
     */
    static #startDate = null;

    /**
     * The timer used for updating and displaying the elapse time
     */
    static #elapseTimer = null;

    /**
     * Enum for the supported Display view options.
     * - home: Displays the inital home view
     * - help: Displays the help popup
     * - sendFile: Displays the "Send file" view
     * - receiveFile: Displays the "Receive file" view
     * @readonly
     */
    static ViewOption = Object.freeze({
        home: { id: "homeBox" },
        help: { id: "helpBox" },
        sendFile: { id: "sendBox", qrViewId: "senderQRView", cameraCanvasId: "senderCameraCanvas", lblProgressId: "lblProgress", lblElapsTimeId: "lblElapsTimeId", lblFileId: "lblFile", lblChunkInfoId: "lblChunkInfo", },
        receiveFile: { id: "receiveBox", qrViewId: "receiverQRView", cameraCanvasId: "receiverCameraCanvas", lblProgressId: "lblProgress1", lblElapsTimeId: "lblElapsTimeId1", lblFileId: "lblFile1", lblChunkInfoId: "lblChunkInfo1" }
    });

    /**
     * Enum for the supported Chunk types which are transmitted between Sender and Receiver.
     * - metaInfo: Indicates to the Receiver that a new file transmission is about started, and the Sender is passing all the necessary meta info needed in order for the Receiver to create the FileWorker on his side and be ready to proceed receiving chunks
     * - metaInfoReceived: Indicates to the Sender that the Received has successfully received the metaInfo data, so that Sender can start sending the file chunks
     * - okNext: Indicates to the Receiver device that any previously received package is valid based on the provided evalSha256, so he can process the carried base64 block as next chunk, and proceed notifying back the Sender with the new correpsonding evalSha256. If the number of valid received chunks is equal to the toal expected chunks, then the file transfer can be considered completed.
     * - evalSha256: Indicates to the Sender that the Receiver has received the new chunk and the carried string block is the SHA-256 of the new chunk which needs to be compared on the Sender to evaluate if the chunk is not corrupted. In case it's ok, a new file chunk will be sent to the Receiver, otherwise 'invalidSha256' will be sent to the Receiver along with the previous chunk so that the Receiver can drop the pending chunk and try again b
     * - invalidSha256: Indicates to the Receiver that the last received chunk on his side is considered corrupt as the sha256 sent to the Sender via 'evalSha256' does not match with the one that the Sender is expecting. In this case the last chunk will be dropped and the Receiver will try to decode again the same chunk from the Sender
     * - completed: Indicates to the Receiver that the transfer session is over. The receiver should stop all from his side and save on the disk the in-memory buffer as file
     * - unknown: The carried chunk over QR images is not supported or not recognized
     * @readonly
     */
    static ChunkType = Object.freeze({
        metaInfo: { id: 0 },
        metaInfoReceived: { id: 1 },
        okNext: { id: 2 },
        evalSha256: { id: 3 },
        invalidSha256: { id: 4 },
        completed: { id: 50 },
        unknown: { id: 100 }
    });

    /**
	 * Displays the view with the given option on the screen, performing any necessary setup
	 * 
	 * @public
	 * @param {QRFileTransfer.Core.ViewOption} option the option to be used in order to display the corresponding view
     * 
	 */
    static loadView(view) {
        let div = document.getElementById(view.id);
        if (div === null || div === "undefined") { return }

        // Hide all the views in order to display only the desired one
        for (var viewOption in QRFileTransfer.Core.ViewOption) {
            let id = QRFileTransfer.Core.ViewOption[viewOption].id;
            document.getElementById(id).style.display = "none";
        }
        
        // remove andy display:none in order to show up the view
        div.style.display = null;

        let previousView = this.#displayedView;

        // keep track of the displaying view except of help view
        if (view != QRFileTransfer.Core.ViewOption.help){
            this.#displayedView = view
        }

        // If the view is not already shown, do any necessary custom action
        if (this.#displayedView !== null && this.#displayedView != previousView) {
            switch (view){
                case QRFileTransfer.Core.ViewOption.home: {
                    switch (previousView) {
                        case QRFileTransfer.Core.ViewOption.sendFile: { QRFileTransfer.Core.stopSending(); break; }
                        case QRFileTransfer.Core.ViewOption.receiveFile: { QRFileTransfer.Core.stopReceiving(); break; }
                        default: { break; }
                    }
                    break;
                }
                case QRFileTransfer.Core.ViewOption.sendFile: {
                    this.#setupSender();
                    break;
                }
                case QRFileTransfer.Core.ViewOption.receiveFile: {
                    this.#setupReceiver();
                    break;
                }
                default: { break; }
            }
        }
        
    }

    /**
     * Displays the previously tracked view
     */
    static closeHelp() { if (this.#displayedView !== null) { this.loadView(this.#displayedView); } }

    /**
     * For the Sender mode only, it syncs the file worker size with the selected size option into the dropdown selection box, and updates the displayed meta info
     * 
     * @public
     */
    static updateSenderChunkSize() {
        if (this.#isSenderReceiverView() == false ) { return }
        if (this.#fileWorker === null) { return }
        let customChunkSize = document.getElementById("inputChunkSize").value;
        this.#fileWorker.updateChunkSize(parseInt(customChunkSize) != "NaN" ? parseInt(customChunkSize) : 128);
        this.#updateMetaInformation();
    }

    /**
     * Start the process of sending the selected file in the "Send file" view
     * 
     * @public
     */
    static startSending() {
        if (QRFileTransfer.Core.#isSenderReceiverView() == false ) { return }
        if (QRFileTransfer.Core.#isRunning == true) { return }
        // disable the Buttons
        document.getElementById("btnInputFile").disabled = true;
        document.getElementById("inputChunkSize").disabled = true;
        document.getElementById("btnStartSending").disabled = true;

        QRFileTransfer.QRDecoder.setupAndStart(QRFileTransfer.Core.#displayedView.cameraCanvasId, (result, error) => {
            if (result == true) {
                document.getElementById("togglesContainer").style.display = null;
                QRFileTransfer.Core.#showElapsedTime(true);
                QRFileTransfer.Core.#isRunning = true;
                // Start by sending the meta info in order for the Receiver to be set up
                QRFileTransfer.Core.#updateQRImage(QRFileTransfer.Core.ChunkType.metaInfo, JSON.stringify(QRFileTransfer.Core.#fileWorker.metaInfo()));
                QRFileTransfer.Core.#updateProgresses();
            } else {
                // reset and setup the sender again
                // TODO: notify also the user about the camera feed issue 
                QRFileTransfer.Core.stopSending();
            }
        }, QRFileTransfer.Core.#onQRDataReceived)
    }

    /**
     * Stops the process of sending the selected file in the "Send file" view
     */
    static stopSending() {
        QRFileTransfer.QRDecoder.stop();
        QRFileTransfer.Core.#setupSender();
    }

    /**
     * Start the process of receiving a file from a Sender device
     * 
     * @public
     */
    static startReceiving() {
        if (QRFileTransfer.Core.#isSenderReceiverView() == false ) { return }
        if (QRFileTransfer.Core.#isRunning == true) { return }
        // disable the Buttons
        document.getElementById("btnStartReceiving").disabled = true;
        QRFileTransfer.QRDecoder.setupAndStart(QRFileTransfer.Core.#displayedView.cameraCanvasId, (result, error) => {
            if (result == true){
                document.getElementById("togglesContainer1").style.display = null;
                QRFileTransfer.Core.#showElapsedTime(true);
                QRFileTransfer.Core.#isRunning = true;
            } else {
                // reset and setup the sender again
                // TODO: notify also the user about the camera feed issue 
                QRFileTransfer.Core.stopReceiving();
            }
        }, QRFileTransfer.Core.#onQRDataReceived)
    }

    /**
     * Stops the process of receiving the selected file in the "Send file" view
     * 
     * @public
     */
    static stopReceiving() {
        QRFileTransfer.QRDecoder.stop();
        QRFileTransfer.Core.#setupReceiver();
    }

    /**
     * Toggles the Displayed QR Code from reduced to full screen
     */
    static toggleQRFullscreen() {
        let classList = document.getElementById(QRFileTransfer.Core.#displayedView.qrViewId).classList;
        if (classList.contains("qrBoxFull") === true) {
            document.getElementById(QRFileTransfer.Core.#displayedView.qrViewId).classList.remove("qrBoxFull");
        } else {
            document.getElementById(QRFileTransfer.Core.#displayedView.qrViewId).classList.add("qrBoxFull");
        }
    }

    /**
     * Starts/Stops the timer for displaying and updating the elapsed time
     * @param {Boolean} start whether the timer should start or stop running
     */
    static #showElapsedTime(start) {
        if (QRFileTransfer.Core.#isSenderReceiverView() == false ) { return }
        if (start === true) {
            this.#startDate = Date.now();
            document.getElementById(QRFileTransfer.Core.#displayedView.lblElapsTimeId).innerHTML = QRFileTransfer.Utils.elapsedTime(this.#startDate);
            this.#elapseTimer = setInterval(() => {
                if (QRFileTransfer.Core.#isSenderReceiverView() == false ) { return }
                document.getElementById(QRFileTransfer.Core.#displayedView.lblElapsTimeId).innerHTML = QRFileTransfer.Utils.elapsedTime(this.#startDate);
            }, 1000);
        }else {
            clearInterval(this.#elapseTimer);
            this.#elapseTimer = null;
            this.#startDate = null;
            document.getElementById(QRFileTransfer.Core.#displayedView.lblElapsTimeId).innerHTML = "n/a";
        }
    }

    /**
     * Reset the shared states
     * 
     * @private
     */
    static #reset() {
        this.#isRunning = false;
        this.#fileWorker = null;
        this.#showElapsedTime(false);
        this.#updateMetaInformation(null);
        this.#updateProgresses();
        this.#updateQRImage(null, null);
    }

    /**
     * Indicates if the current selected view is the Sender or the Receiver view
     * 
     * @private
     * @return {Boolean} true if the contion is met
     */
    static #isSenderReceiverView() { return (this.#displayedView == QRFileTransfer.Core.ViewOption.sendFile || this.#displayedView == QRFileTransfer.Core.ViewOption.receiveFile ) }

    /**
	 * Displays/Updates the meta information of the file which is getting processed
	 * 
	 * @private
	 */
    static #updateMetaInformation() {
        if (QRFileTransfer.Core.#isSenderReceiverView() == false ) { return }
        let metaInfo = null;
        if (QRFileTransfer.Core.#fileWorker !== null) { metaInfo = QRFileTransfer.Core.#fileWorker.metaInfo(); }
        document.getElementById(QRFileTransfer.Core.#displayedView.lblFileId).innerHTML = (metaInfo === null ? "n/a" : metaInfo.fileName + " (" + QRFileTransfer.Utils.formatBytes(metaInfo.fileSize) + ")");
        document.getElementById(QRFileTransfer.Core.#displayedView.lblChunkInfoId).innerHTML = (metaInfo === null ? "n/a" : metaInfo.fileChunks + " (" + QRFileTransfer.Utils.formatBytes(metaInfo.chunkSize) + " each)");
    }

    /**
	 * Displays/Updates the progresses on the file which is getting processed
	 * 
	 * @private
	 */
    static #updateProgresses() {
        if (QRFileTransfer.Core.#isSenderReceiverView() == false ) { return }
        // Display default state if not running
        if (QRFileTransfer.Core.#isRunning == false) {
            document.getElementById(QRFileTransfer.Core.#displayedView.lblProgressId).innerHTML = "n/a";
            return;
        }
        if (QRFileTransfer.Core.#fileWorker !== null) {
            document.getElementById(QRFileTransfer.Core.#displayedView.lblProgressId).innerHTML = (QRFileTransfer.Core.#fileWorker.progress() * 100).toFixed(2) + " % (" + QRFileTransfer.Core.#fileWorker.curChunk + ")";
        }
    }

    /**
	 * Clears the currently shown QR Code image and generates a new one based on the given input if provided. Pass null to just clear the image
	 * 
	 * @private
	 * @param {QRFileTransfer.Core.ChunkType} chunkType the chunk type to be associated to the carrying body input
     * @param {String} input the body content of the generating QR Code
     * 
	 */
    static #updateQRImage(chunkType, input) {
        if (QRFileTransfer.Core.#isSenderReceiverView() == false ) { return; }
        if (input === null && document.getElementById(QRFileTransfer.Core.#displayedView.qrViewId).getElementsByTagName("img").length > 0 ) {
            document.getElementById(QRFileTransfer.Core.#displayedView.qrViewId).style.display = "none";
            document.getElementById(QRFileTransfer.Core.#displayedView.qrViewId).getElementsByTagName("img")[0].src = "";
            return;
        }
        document.getElementById(QRFileTransfer.Core.#displayedView.qrViewId).style.display = null;
        let qrData = { "ckTId" : chunkType.id, "bd": input.trim(), "dt": Date.now() }
        
        QRFileTransfer.Utils.generateQRCode(JSON.stringify(qrData));
    }

    /**
     * Convenience method which returns the enum chunk type from the given chunk type identifier
     * @param {Number} id 
     */
    static #chunkTypeFromId(id) { 
        switch (id) {
            case 0: { return QRFileTransfer.Core.ChunkType.metaInfo; } 
            case 1: { return QRFileTransfer.Core.ChunkType.metaInfoReceived; } 
            case 2: { return QRFileTransfer.Core.ChunkType.okNext; } 
            case 3: { return QRFileTransfer.Core.ChunkType.evalSha256; } 
            case 4: { return QRFileTransfer.Core.ChunkType.invalidSha256; } 
            case 50: { return QRFileTransfer.Core.ChunkType.completed; } 
            default: { return QRFileTransfer.Core.ChunkType.unknown; } 
        }
    }

    /**
     * Callback method called when a string is decoded from a recognized QR Code from the camera feed
     * 
     * @private
     * @param {String} rawData 
     */
    static async #onQRDataReceived(rawData) {
        if (QRFileTransfer.Core.#isRunning == false) { return }
        if (rawData === null) { return }
        let jsonData = rawData.trim();
        if (jsonData.length == 0 ) { return }
        let jsObj = null;
        // Make sure is a valid json object
        try { jsObj = JSON.parse(jsonData); } catch(e) { return }
        // Make sure is a valid object with expectable properties
        if (jsObj["ckTId"] === undefined || jsObj["bd"] === undefined || jsObj["dt"] === undefined) { return }
        // extract the chunk type and the chunk data
        let chunkType = QRFileTransfer.Core.#chunkTypeFromId(jsObj["ckTId"]);
        let qrData = jsObj["bd"];
        let datetime = jsObj["dt"];

        let previousDatetime = QRFileTransfer.Core.#lastReceivedDatetime;
        // Update the date time for the next cycle
        QRFileTransfer.Core.#lastReceivedDatetime = datetime;

        // Ignore the qr data if is the same exact one of the previous acquired qr code from the camera feed.
        if (previousDatetime === QRFileTransfer.Core.#lastReceivedDatetime) { return }
        
        switch (QRFileTransfer.Core.#displayedView) {
            case QRFileTransfer.Core.ViewOption.sendFile: {
                switch (chunkType) {

                    // The Receiver confirmed that meta info were received. The Sender can now start sending the chunks
                    case QRFileTransfer.Core.ChunkType.metaInfoReceived: {
                        if (QRFileTransfer.Core.#fileWorker === null) { return }
                        console.log("QRFileTransfer.Core.ChunkType.metaInfoReceived");
                        // Read the next file chunk and updates the file worker internal states
                        await QRFileTransfer.Core.#fileWorker.readNextChunk();
                        // Display a new QR Code with the new chunk data for the Receiver to be decoded
                        QRFileTransfer.Core.#updateQRImage(QRFileTransfer.Core.ChunkType.okNext, QRFileTransfer.Core.#fileWorker.lastChunkBase64);
                        QRFileTransfer.Core.#updateProgresses();
                        break;
                    }
                    // The Receiver provided the SHA-256 of the last received chunk data. The sender will evaluate it against his last SHA-256 and, if valid, will continue with the next chunk, otherwise will notify the Receiver that the data was corrupted during his decoding
                    case QRFileTransfer.Core.ChunkType.evalSha256: {
                        if (QRFileTransfer.Core.#fileWorker === null) { return }
                        console.log("QRFileTransfer.Core.ChunkType.evalSha256");
                        let receiverChunkSha256 = qrData;
                        if (receiverChunkSha256 == QRFileTransfer.Core.#fileWorker.lastChunkSha256) {

                            // if the last sent chunk was the last expected one then the file transfer should be considered done.
                            if (QRFileTransfer.Core.#fileWorker.curChunk == QRFileTransfer.Core.#fileWorker.fileChunks) {

                                // Display a new QR Code with the new chunk data for the Receiver to be decoded, so that the process will be considered done
                                QRFileTransfer.Core.#updateQRImage(QRFileTransfer.Core.ChunkType.completed, "");
                                // Stop the Sender session after a couple of seconds, just to give time to the Receiver to detect the 'completed' QR Code signal
                                // If the receiver misses this, it will stuck and will require a manual completionon the Receiver side
                                setTimeout(() => { QRFileTransfer.Core.stopSending(); }, 2000);
                            } else {
                                await QRFileTransfer.Core.#fileWorker.readNextChunk();
                                // Display a new QR Code with the new chunk data for the Receiver to be decoded, so that the previous chunk will be considered valid
                                QRFileTransfer.Core.#updateQRImage(QRFileTransfer.Core.ChunkType.okNext, QRFileTransfer.Core.#fileWorker.lastChunkBase64);
                                QRFileTransfer.Core.#updateProgresses();
                            }
                        } else {
                            // Display a new QR Code with the new chunk data for the Receiver to be decoded, invalididating the last chunk and trying again with this
                            QRFileTransfer.Core.#updateQRImage(QRFileTransfer.Core.ChunkType.invalidSha256, QRFileTransfer.Core.#fileWorker.lastChunkBase64);
                            QRFileTransfer.Core.#updateProgresses();
                        }
                        break;
                    }
                    default: { break; }
                }
                break;
            }

            case QRFileTransfer.Core.ViewOption.receiveFile: {
                switch (chunkType) {
                    
                    // The Sender started the file transfering session by providing the meta info needed to setup the FileWorker on the Receiver side
                    case QRFileTransfer.Core.ChunkType.metaInfo: {
                        // Prevent to receive a different meta info if one has been already provided for this session
                        if (QRFileTransfer.Core.#fileWorker !== null) { return }
                        console.log("QRFileTransfer.Core.ChunkType.metaInfo");
                        let senderMetaInfo = null;
                        try { senderMetaInfo = JSON.parse(qrData); } catch (e) { return }
                        QRFileTransfer.Core.#fileWorker = QRFileTransfer.FileWorker.createWriter(senderMetaInfo);
                        QRFileTransfer.Core.#updateMetaInformation();
                        QRFileTransfer.Core.#updateProgresses();
                        // Display a new QR Code to notify the sender that the metadata has been successfully received, so the chunk transfering can start
                        QRFileTransfer.Core.#updateQRImage(QRFileTransfer.Core.ChunkType.metaInfoReceived, "");
                        break;
                    }
                    // The Sender provided a new file chunk to be appended to the Receiver buffer. The Receiver will provide the SHA-256 of it in order for the Sender to validate it and continue with the next chunk if needed
                    case QRFileTransfer.Core.ChunkType.okNext: {
                        // Prevent to process a file chunk if no FileWorker instance exists. If null means that no meta info was was provided
                        if (QRFileTransfer.Core.#fileWorker === null) { return }
                        console.log("QRFileTransfer.Core.ChunkType.okNext");
                        QRFileTransfer.Core.#fileWorker.writerCommitPendingChunk();
                        await QRFileTransfer.Core.#fileWorker.writerSetPendingChunk(qrData);
                        QRFileTransfer.Core.#updateProgresses();
                        // Display a new QR Code to notify the sender that a new chunk has been provided and there's the sha-256 to be evaluated back from it
                        QRFileTransfer.Core.#updateQRImage(QRFileTransfer.Core.ChunkType.evalSha256, QRFileTransfer.Core.#fileWorker.lastChunkSha256);
                        break;
                    }
                    // The Sender provided a new file chunk to be appended to the Receiver buffer indicating to drop the last one as was invalid based on the provided SHA-256. The Receiver will drop the last chunk, set a new pending one and provide the SHA-256 of it in order for the Sender to re-validate it and continue with the next chunk if needed
                    case QRFileTransfer.Core.ChunkType.invalidSha256: {
                        // Prevent to process a file chunk if no FileWorker instance exists. If null means that no meta info was was provided
                        if (QRFileTransfer.Core.#fileWorker === null) { return }
                        console.log("QRFileTransfer.Core.ChunkType.invalidSha256");
                        await QRFileTransfer.Core.#fileWorker.writerSetPendingChunk(qrData);
                        QRFileTransfer.Core.#updateProgresses();
                        // Display a new QR Code to notify the sender that a new chunk has been provided and there's the sha-256 to be evaluated back from it
                        QRFileTransfer.Core.#updateQRImage(QRFileTransfer.Core.ChunkType.evalSha256, QRFileTransfer.Core.#fileWorker.lastChunkSha256);
                        break;
                    }
                    // The Sender notified that the file transfer session is over, so we should stop the Camera feed and write the data on the disk
                    case QRFileTransfer.Core.ChunkType.completed: {
                        // Prevent to process a file chunk if no FileWorker instance exists. If null means that no meta info was was provided
                        if (QRFileTransfer.Core.#fileWorker === null) { return }
                        console.log("QRFileTransfer.Core.ChunkType.completed");
                        // Commit the last pending block before proceeding
                        QRFileTransfer.Core.#fileWorker.writerCommitPendingChunk();
                        // Write the data on disk and stop the session
                        await QRFileTransfer.Core.#fileWorker.writerDownloadFile();
                        // Stop the Receiver session
                        QRFileTransfer.Core.stopReceiving();
                        break;
                    }
                    default: { break; }
                }
                break;
            }
            default: { break; }
        }
    }

    /**
     * Initializes the Sender view
     * 
     * @public
     */
    static #setupSender() {
        // Attach the view which needs to be used for displaying the generated QR Codes
        QRFileTransfer.Utils.setQRCodeViewer(QRFileTransfer.Core.#displayedView.qrViewId,512,512);

        // Configure the controls to the initial state
        document.getElementById("btnInputFile").disabled = false;
        document.getElementById("inputChunkSize").disabled = true;
        document.getElementById("btnStartSending").disabled = true;
        document.getElementById("togglesContainer").style.display = "none";

        let fileSelector = document.getElementById("inputFile");
        // Remove any previously attached observer and selected file
        if (QRFileTransfer.Core.#onFileChanged !== null) {
            fileSelector.removeEventListener("change", QRFileTransfer.Core.#onFileChanged);
            fileSelector.value = "";
        }
        // Reset the interface and the file worker
        QRFileTransfer.Core.#reset();
        
        // Attach a new observer for the file picker change 
        QRFileTransfer.Core.#onFileChanged = (event) => {
            let files = event.target.files;
            QRFileTransfer.Core.#reset();
            // If no file was selected, then abort
            if (files === null || files.length == 0) { 
                // disable the 'Start sending' button and 'Chunk size'
                document.getElementById("btnStartSending").disabled = true;
                document.getElementById("inputChunkSize").disabled = true;
                return 
            }
            document.getElementById("inputChunkSize").disabled = false;
            // create the file worked based on the selected file
            QRFileTransfer.Core.#fileWorker = QRFileTransfer.FileWorker.createReader(files[0]);
            
            // apply chunk size
            let customChunkSize = document.getElementById("inputChunkSize").value;
            QRFileTransfer.Core.#fileWorker.updateChunkSize(parseInt(customChunkSize) != "NaN" ? parseInt(customChunkSize) : 128);

            // update the meta information on the screen
            QRFileTransfer.Core.#updateMetaInformation();
            // enable the 'Start sending' button and disable the dropdown
            document.getElementById("btnStartSending").disabled = false;
        }
        fileSelector.addEventListener('change', QRFileTransfer.Core.#onFileChanged);
    }

    /**
     * Initializes the Receiver view
     * 
     * @public
     */
    static #setupReceiver() {
        // Attach the view which needs to be used for displaying the generated QR Codes
        QRFileTransfer.Utils.setQRCodeViewer(QRFileTransfer.Core.#displayedView.qrViewId,512,512);

        // Configure the control to the initial state
        document.getElementById("btnStartReceiving").disabled = false;
        document.getElementById("togglesContainer1").style.display = "none";

        // Reset the interface and the file worker
        QRFileTransfer.Core.#reset();
    }

}

/**
 * Utils class implementation
 */
QRFileTransfer.Utils = class {

    /**
     * The private reference to the QRCode object in charge of processing the qr code images
     */
    static #qrCode = null;

    /**
	 * set the qr code view which will display any generated qr code image on the screen
	 * 
	 * @public
	 * @param {String} domID the dom element identifier which will display the qr code image
	 * @param {Number} qrImageWidth the expected width to be used for the generated image
     * @param {Number} qrImageHeight the expected height to be used for the generated image
     * 
     * @return {Boolean} true if the QR Code viewer is set succesfully, false otherwise
	 */
    static setQRCodeViewer(domID,qrImageWidth,qrImageHeight) {
        if (document.getElementById(domID) === null) { return false }
        document.getElementById(domID).innerHTML = "";
        QRFileTransfer.Utils.#qrCode = new QRCode(document.getElementById(domID), {
            width : qrImageWidth,
            height : qrImageHeight,
            correctLevel : QRCode.CorrectLevel.M
        });
        return true
    }

    /**
	 * Generates the qr code image associated to the input string and shows it into the previously assigned viewer
	 * 
	 * @public
	 * @param {String} input the input text to be represented as QR Code image
     * 
     * @return {Boolean} true if the QR Code viewer could be generated, false if no qr code object was setup 
	 */
    static generateQRCode(input) {
        if (QRFileTransfer.Utils.#qrCode === null) { return false }   
        try {
            QRFileTransfer.Utils.#qrCode.makeCode(input);
            return true;
        } catch(e) {
            console.error("Unable to generate the QR from the input (" + input.length + " Bytes). " + e)
            return false;
        }
    }

    /**
	 * Returns the SHA-256 representation of the given input text
	 * 
	 * @public
	 * @param {String} message the input text to be hashed
	 * @return {String} the SHA-256 representation string
	 */
    static async sha256(message) {
        if (message === null ) { return null }
        const msgUint8 = new TextEncoder().encode(message);                           // encode as (utf-8) Uint8Array
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);           // hash the message
        const hashArray = Array.from(new Uint8Array(hashBuffer));                     // convert buffer to byte array
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join(''); // convert bytes to hex string
        return hashHex.trim();
    }

    /**
	 * Returns the Base-64 representation string of the given input blob object
	 * 
	 * @public
	 * @param {Blob} blob the input blob to be processed
	 * @return {Promise} A promise which returns the Base-64 representation of the given blob, or null if no blob was provided
	 */
    static blobAsBase64(blob) {
        if (blob === null ) { return null }
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        let prom = new Promise(resolve => { reader.onloadend = () => { resolve( (reader.result.split(',')[1]).trim() ); }; });
        return prom;
    }

    /**
	 * Returns the uInt8Array content from the provided Base64 string
	 * 
	 * @public
	 * @param {String} blob the input blob to be processed
	 * @return {Promise} a promise returning the uInt8Array content from the given Base-64, or null on error
	 */
    static bufferArrayFromBase64(base64) {
        if (base64 === null ) { return null }
        let prom = new Promise(resolve => {
            let raw = window.atob(base64);
            const uInt8Array = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; ++i) { uInt8Array[i] = raw.charCodeAt(i); }
            resolve(uInt8Array);
        });
        return prom;
    }

    /**
	 * Returns the Human readable formatted size from the given number of Bytes. By default rounded to two decimals
	 * 
	 * @public
	 * @param {Number} a the input size in Bytes to be formatted
     * @param {Number} b the desired number of decimals to be used. Default: 2
	 * @return {String} the human readable formatted size
	 */
    static formatBytes(a,b=2){if(0===a)return"0 Bytes";const c=0>b?0:b,d=Math.floor(Math.log(a)/Math.log(1024));return parseFloat((a/Math.pow(1024,d)).toFixed(c))+" "+["Bytes","KB","MB","GB","TB","PB","EB","ZB","YB"][d]}

    /**
     * Returns the elapsed time from the given date in the format HH:MM:SS
     * @param {Date} fromDate the date from which making the differense with the current date
     * @return {String} the formatted string elapsed time
     */
    static elapsedTime(fromDate) { 
        if (fromDate === null) { return "00:00:00"; }
        let milliseconds = Date.now() - fromDate;
        let sec_num = Math.floor(milliseconds/1000);
        let hours   = Math.floor(sec_num / 3600);
        let minutes = Math.floor((sec_num - (hours * 3600)) / 60);
        let seconds = sec_num - (hours * 3600) - (minutes * 60);
    
        if (hours   < 10) {hours   = "0"+hours;}
        if (minutes < 10) {minutes = "0"+minutes;}
        if (seconds < 10) {seconds = "0"+seconds;}
        return hours + ':' + minutes + ':' + seconds;
    }

}

/**
 * FileWorker class implementation
 */
QRFileTransfer.FileWorker = class {

    /**
     * Indicates if the FileWorker is Reading a file. If false, it means that the FileWorker is configured for Writing
     */
    readMode = true;

    /**
     * the reference to the file to be read
     */
    #inputFile = null;

    /**
     * the default chunk size to be read at every access
     */
    #chunkSize = 128;

    /**
     * the referred file MIME type
     */
    inputFileType = null;

    /**
     * the referred file name
     */
    inputFileName = null;

    /**
     * the referred file size in Bytess
     */
    fileSize = 0;

    /**
     * the total file chunks to be processed in order to cover the enitre referred file, based on the given chunk size
     */
    fileChunks = 0;

    /**
     * the current chunk over the the toal number of chunks
     */
    curChunk = 0;

    /**
     * The last processed Chunk as Blob
     */
    lastChunkBlob = null;
    
    /**
     * The last processed Chunk as Base64
     */
    lastChunkBase64 = null;

    /**
     * The Sha256 of 'lastChunkBase64'
     */
    lastChunkSha256 = null;

    /**
     * For the readMode 'false' only, this is the in-memory array of Blob chunks which contains the overall data cumulated up to now which can be downloaded on the disk when 
     * required.
     */
    #writerBuffer = [];

    #writerUrl = null;
    
    /**
     * Creates and return a new instance of the FileWorker configured for READING from the given file
     * 
     * @public
     * @param {File} file the source file to be read
     * @return {QRFileTransfer.FileWorker} the new instance of FileWorker configured as file reader
     */
    static createReader(file){
        let worker = new QRFileTransfer.FileWorker();
        worker.#inputFile = file;
        worker.inputFileType = file.type.trim().length == 0 ? "application/octet-stream" : file.type;
        worker.inputFileName = file.name;
        worker.fileSize = file.size;
        worker.updateChunkSize(128);
        worker.readMode = true;
        return worker;
    }

    /**
     * Creates and return a new instance of the FileWorker configured for WRITING data to be downloaded as file on the running device
     * 
     * @public
     * @param {Object} senderMetaInfo the meta information object which configures the worker in order to collect the chunks and properly create the file
     * @return {QRFileTransfer.FileWorker} the new instance of FileWorker configured as file writer
     */
    static createWriter(senderMetaInfo) {
        let worker = new QRFileTransfer.FileWorker();
        worker.inputFileType = senderMetaInfo["fileType"];
        worker.inputFileName = senderMetaInfo["fileName"];
        worker.fileSize = senderMetaInfo["fileSize"];
        worker.#chunkSize = senderMetaInfo["chunkSize"];
        worker.fileChunks = senderMetaInfo["fileChunks"];
        worker.readMode = false;
        return worker;
    }

    /**
     * For the readMode 'true' only, updates the Chunk size and recalculates the number of file chunks
     * 
     * @public
     * @param {Number} size the new size of the single chunk
     */
    updateChunkSize(size) {
        if (this.readMode == false) { return }
        this.#chunkSize = size;
        this.fileChunks = Math.ceil(this.#inputFile.size/this.#chunkSize,this.#chunkSize);
    }

    /**
	 * Returns the meta information object of the referred file. 
     * It provides information like file name, MIME type, size in Bytes, number of chunks needed to send/receive, size of a default chunk
	 * 
	 * @public
     * 
     * @return {Object} meta information object of the referred file.
	 */
    metaInfo() {
        if (this.readMode == true && this.#inputFile === null ) { return null; }
        let data = {};
        data["fileName"] = this.inputFileName;
        data["fileType"] = this.inputFileType;
        data["fileSize"] = this.fileSize;
        data["fileChunks"] = this.fileChunks;
        data["chunkSize"] = this.#chunkSize;
        return data;
    }

    /**
	 * Returns the percentage from 0.0 to 1.0 indicating the I/O progress on the referred file
	 * 
	 * @public
     * @return {Number} the percentage of the I/O progress.
	 */
    progress() { return (this.curChunk / this.fileChunks); }

    /**
	 * Reads the next binary chunk of the referred file if the FileWorker is configured for writing. 
     * The processed Blob, Base64 representation and Sha256 of the Base64 are stored
     * in the properties 'lastChunkBlob', 'lastChunkBase64' and 'lastChunkSha256'. If the last chunk has been reached or no input file was provided, 
     * then 'lastChunkBlob', 'lastChunkBase64' and 'lastChunkSha256' will contain 'null'
	 * 
	 * @public
     * 
	 */
    async readNextChunk() {
        if (this.readMode == false) { return }
        if (this.#inputFile === null || this.curChunk >= this.fileChunks ) { 
            this.lastChunkBlob = null;
            this.lastChunkBase64 = null;
            this.lastChunkSha256 = null;
            return
        }
        let offset = this.curChunk * this.#chunkSize;
        this.lastChunkBlob = this.#inputFile.slice(offset, offset + this.#chunkSize);
        this.lastChunkBase64 = await QRFileTransfer.Utils.blobAsBase64(this.lastChunkBlob);
        this.lastChunkSha256 = await QRFileTransfer.Utils.sha256(this.lastChunkBase64);
        this.curChunk += 1;
    }

    /**
     * Sets the pending chunk in order to evaluate if this needs to be committed or not
     * 
     * @public
     * @param {String} base64Chunk the base64 chunk to be appended to the buffer
     */
    async writerSetPendingChunk(base64Chunk) {
        if (this.readMode == true) { return }
        let lastChunkUInt8Array = await QRFileTransfer.Utils.bufferArrayFromBase64(base64Chunk.trim());
        if (lastChunkUInt8Array === null) { return }
        this.lastChunkBlob = new Blob([lastChunkUInt8Array], null);
        this.lastChunkBase64 = base64Chunk;
        this.lastChunkSha256 = await QRFileTransfer.Utils.sha256(this.lastChunkBase64);
    }

    /**
     * Writes the next chunk in the buffer if the FileWorker is configured for writing.
     *
     * @public
     * @param {String} base64Chunk the base64 chunk to be appended to the buffer
     * @param {Boolean} commitPending if true it will append the 'pendingWriterChunk' to the 'writerBuffer'
     */
    writerCommitPendingChunk() {
        if (this.readMode == true) { return }
        if (this.lastChunkBlob === null) { return }
        // append the new blob chunk to the buffer
        this.#writerBuffer.push(this.lastChunkBlob);
        this.lastChunkBlob = null;
        this.lastChunkBase64 = null;
        this.lastChunkSha256 = null;
        this.curChunk += 1;   
    }

    /**
     * Downloads the file
     * 
     * @public
     */
    async writerDownloadFile() {
        let a = await this.#writerCreateDownloadFile();
        document.body.appendChild(a);
        a.style = 'display: none';
        a.click();
        let that = this;
        setTimeout(() => {
          //window.URL.revokeObjectURL(that.#writerUrl);
          document.body.removeChild(a);
          //that.#writerUrl = null;
        }, 1);
    }

    /**
     * Creates the tag for downloading the buffer as file to the disk
     * 
     * @private
     */
    #writerCreateDownloadFile() {
        if (this.readMode == true) { return }
        if (this.#writerBuffer === null) { return }
        let that = this;
        let prom = new Promise(resolve => { 
            let resultingFileBlob = new Blob(that.#writerBuffer, {type : that.inputFileType});
            that.#writerUrl = window.URL.createObjectURL(resultingFileBlob);
            let aTag = document.createElement("a");
            aTag.href = that.#writerUrl;
            aTag.download = that.inputFileName;
            resolve(aTag); 
        });
        return prom;
    }
}

/**
 * QRDecoder class implementation
 */
QRFileTransfer.QRDecoder = class {

    /**
     * Ideal video FPS
    */
    static fpsIdeal = 10;

    /**
     * Max allowed video FPS
    */
    static fpsMax = 10;

    /**
     * Indicates if the video session is running or not
     */
    static #scanning = false;

    /*
    Delay in milliseconds which is used to schedue the process of the next frame from the video stream
    */
    static scheduleFrameDelay = 5;

    /**
     * Reference to the video object which is feeding the image stream
     */
    static #video = null;

    /**
     * Reference to the Canvas DOM element which will be used to render the camera feed
     */
    static #canvasElement = null;

    /**
     * Reference to the 2D context of 'canvasElement'
     */
    static #canvasCtx = null;

    /**
     * Indicates if the camera canvas should be displayed on screen while the session is running
     */
    static #showCameraWhileRunning = true;

    /**
     * The function to be called when a QR Code image is properly decoded and the correpsonding data need to be given back in this callback
     */
    static #onQRCodeDetected = null;

    /**
	 * Setup and runs the Camera session in order to scan the image looking for any valid QR Code.
	 * 
	 * @public
     * @param {String} canvasId the identitifer of the canvas element into which render and process the camera feed
     * @param {Function} onSetupCompleted function callback to be passed in order to get informed when the setup finishes. The result is returned with it
     * @param {Function} onQRCodeDetected function callback to be passed in order to get notified when a valid QR code gets decoded. the data object is returned with it
	 */
    static async setupAndStart(canvasId, onSetupCompleted, onQRCodeDetected) {
        if (onSetupCompleted === null) { return }
        if (this.#scanning == true) { onSetupCompleted(false); return }

        let stream = null;
        try {
            // Use facingMode: environment to attempt to get the front camera on phones
            let constraints = { video: { facingMode: "environment", frameRate: { ideal: this.fpsIdeal, max: this.fpsMax } } };
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch(err) { onSetupCompleted(false, err); return }
        
        this.#canvasElement = document.getElementById(canvasId);
        this.#canvasCtx = this.#canvasElement.getContext("2d");
        
        this.#video = document.createElement("video");
        this.#video.setAttribute("playsinline", true); // prevents fullscreen video playing
        this.#video.srcObject = stream;
        this.#video.play();

        this.#scanning = true;
        this.#onQRCodeDetected = onQRCodeDetected;
        requestAnimationFrame(this.#processFrame);
        onSetupCompleted(true);
    }

    /**
	 * Stops the camera feed and the QR decoding process if needed
	 * 
	 * @public
	 */
    static stop() {
        if ( this.#scanning == false ) { return }
        this.#onQRCodeDetected = null;
        this.#video.srcObject.getTracks().forEach(track => { track.stop(); });
        this.#video = null;
        this.#canvasCtx = null;
        this.#canvasElement.hidden = true;
        this.canvasElement = null;
        this.#scanning = false;
    }

    /**
     * Toggles the flag which indicates if the canvas with the camera feed should be displayed while the session is running.
     * If this method gets called while thw session is already runnig, it will apply the visibility state right away to the canvas element
     * 
     * @public
     */
    static toggleCameraFeedVisibilityWhileRunning() {
        this.#showCameraWhileRunning = !this.#showCameraWhileRunning;
        if (this.#scanning == true && this.#canvasElement !== null) { this.#canvasElement.hidden = !this.#showCameraWhileRunning; }
    }

    /**
	 * Process the next image frame from the camera feed
	 * 
	 * @private
	 */
    static async #processFrame() {
        if (QRFileTransfer.QRDecoder.#scanning == false) { return }
        let This = QRFileTransfer.QRDecoder;
        if (This.#video.readyState === This.#video.HAVE_ENOUGH_DATA) {
            if (This.#showCameraWhileRunning == true) {
                This.#canvasElement.hidden = false;
            }
            This.#canvasElement.height = This.#video.videoHeight;
            This.#canvasElement.width = This.#video.videoWidth;
            This.#canvasCtx.drawImage(This.#video, 0, 0, This.#canvasElement.width, This.#canvasElement.height);
            let imageData = This.#canvasCtx.getImageData(0, 0, This.#canvasElement.width, This.#canvasElement.height);
            try {
                let code = await This.#decodeImageData(imageData);
                if (code !== null) {
                    This.#onQRCodeDetected(code.data)
                }
            } catch(e) { /*console.log(e);*/ }
        }
        This.#scheduleNextFrame();
    }

    /**
	 * Schedules the next frame processing
	 * 
	 * @private
	 */
    static #scheduleNextFrame() {
        setTimeout(() => { requestAnimationFrame(QRFileTransfer.QRDecoder.#processFrame); }, QRFileTransfer.QRDecoder.scheduleFrameDelay);
    }

    /**
	 * Decodes the given image data representation and, if a valid QR code was recognized into it, returns the correpsonding data from it
	 * 
	 * @private
     * 
     * @return {Promise} the promise which will return the decoded data from the given image data
	 */
    static #decodeImageData(imageData) {
        return new Promise((resolve, reject) => { 
            try {
              let code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
              resolve(code);
            } catch(e) { reject(e); }
        });
    }
}