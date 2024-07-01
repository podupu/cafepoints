
const functions = require('firebase-functions');
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const serviceAccount = require('./permissions.json');
const { v4: uuidv4 } = require('uuid');
const Timestamp = require('firebase-admin/firestore'); // Destructure Timestamp directly

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(cors({ origin: true })); // Enable CORS (be specific about origins in production)
app.use(express.json());

// Middleware to authenticate requests (using Firebase Authentication)
const authenticateUser = async (req, res, next) => {
    const authorization = req.headers.authorization;
    if (!authorization || !authorization.startsWith('Bearer ')) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const idToken = authorization.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);

        // Fetch user document from Firestore using UID
        const userDocRef = db.collection('users').doc(decodedToken.uid);
        let userDoc = await userDocRef.get();

        if (!userDoc.exists) {
            // User doesn't exist, create a new document with default values
            const currentDate = Timestamp.Timestamp.fromDate(new Date());
            const newUser = {
                name: '',
                email: decodedToken.email || '', // Use email from token if available
                phone: '',
                points: 0,
                membershipLevel: 'bronze', 
                isMember: false,
                registrationDate: currentDate,
                lastVisit: currentDate,
                barcode: uuidv4()
            };
            await userDocRef.set(newUser);
            userDoc = await userDocRef.get(); // Fetch the newly created document
        }

        // Attach user data to request object (including barcode)
        req.user = {
            uid: decodedToken.uid,
            barcode: userDoc.data().barcode,
            // Add other relevant user data here if needed
        };
        next();
    } catch (error) {
        console.error('Error verifying token or fetching/creating user data:', error);
        return res.status(500).json({ error: 'Internal server error' }); // Generic error for security
    }
};
// Middleware for User Authentication (ALWAYS ENABLE THIS IN PRODUCTION!)
app.use(authenticateUser);

app.post('/addPointsToUser', authenticateUser, async (req, res) => {
    try {
        const { barcode, numberOfItems, restaurantId } = req.body;
        const userId = req.user.uid;
        let userPoints;

        // 1. Fetch User and Validate Barcode
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) return res.status(404).send({ error: 'User not found' });
        if (barcode !== userDoc.data().barcode) {
            return res.status(400).send({ error: 'Invalid barcode' });
        }

        // 2. Fetch or Create Points Document
        const pointsQuery = db.collection('points')
            .where('userId', '==', userId)
            .where('restaurantId', '==', restaurantId);
        let pointsDoc = (await pointsQuery.get()).docs[0];

        if (!pointsDoc) {
            // Create new points document
            const pointsRef = await db.collection('points').add({
                userId,
                restaurantId,
                numberOfItems
            });
            pointsDoc = await pointsRef.get();
            userPoints = numberOfItems;
        } else {
            // Update existing points document
            const existingPoints = pointsDoc.data().numberOfItems || 0;
            userPoints = existingPoints + numberOfItems;
            await pointsDoc.ref.update({ numberOfItems: userPoints });
        }

        // 3. Fetch Restaurant Limit
        const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
        if (!restaurantDoc.exists) return res.status(404).send({ error: 'Restaurant not found' });
        const pointsLimit = restaurantDoc.data().pointsLimit;

        // 4. Check for Free Coffee and Update Points
        let message = 'Barcode validated successfully!';
        if (userPoints >= pointsLimit) {
            const freeCoffeesEarned = Math.floor(userPoints / pointsLimit);
            userPoints %= pointsLimit; // Calculate remaining points
            message = `Congratulations! You have earned ${freeCoffeesEarned} free coffee(s)!`;

            // Update points document to reflect remaining points
            await pointsDoc.ref.update({ numberOfItems: userPoints });
        }

        return res.send({ message, remainingPoints: userPoints });

    } catch (error) {
        console.error('Error processing points:', error);
        res.status(500).send({ error: 'Failed to process points' });
    }
});


app.get('/restaurants', authenticateUser, async (req, res) => {


    try {
        const snapshot = await db.collection('restaurants').get();
        const restaurantList = snapshot.docs.map(doc => ({
            userId: doc.id,
            ...doc.data()
        }));
        res.status(200).json(restaurantList);
    } catch (error) {
        console.error('Error getting users:', error);
        res.status(500).send('Error getting users');
    }
});

// Create a new user
app.post('/restaurants',authenticateUser, async (req, res) => {

    try {
        const {
            website,
            images,
            address,
            is_open,
            opening_hours,
            description,
            phone_number,
            rating,
            rewardsId,
            locations,
            pointsLimit,
            name,
        } = req.body;

        // Validate required fields
        if (!name || !address || !images) {
            return res.status(400).json({ message: 'Missing required fields' });
        }
        // Generate current timestamp for registrationDate
        const currentDate = Timestamp.Timestamp.fromDate(new Date());

        const newRestaurants = {
            name,
            description: description || '',
            phone_number: phone_number || '',
            address,
            images,
            registrationDate: currentDate,
            website,
            locations,
            pointsLimit,
            rating,
            is_open
        };

        const docRef = await db.collection('restaurants').add(newRestaurants);
        const restaurantId = docRef.id;

        res.status(201).json({ restaurantId, ...newRestaurants });
    } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).send('Error creating user');
    }
});


app.get('/userParticipatedRestaurants', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.uid;

        // Querying points collection for user's participation
        const restaurantsSnapshot = await db.collection('points')
            .where('userId', '==', userId)
            .get();

        // console.log(JSON.stringify(restaurantsSnapshot))
        // Check if the user has participated in any restaurants
        if (restaurantsSnapshot.empty) {
            return res.status(200).json([]); // No participation, return empty array
        }

        // Extract restaurant IDs where the user participated
        const restaurantIds = restaurantsSnapshot.docs.map(doc => doc.data().restaurantId);

        // Fetch restaurant details using the IDs
        const restaurantDetails = await db.getAll(
            ...restaurantIds.map(id => db.collection('restaurants').doc(id))
        );

        // Filter out any restaurants that were not found
        const validRestaurantDetails = restaurantDetails.filter(doc => doc.exists);

        // Format and return the restaurant data
        const restaurantData = validRestaurantDetails.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
        res.status(200).json(restaurantData);

    } catch (error) {
        console.error('Error fetching user participated restaurants:', error);

        // Specific error scenarios
        if (error.code === 'permission-denied') {
            res.status(403).json({ error: 'Permission denied to access this data.' });
        } else if (error.code === 'not-found') {
            res.status(404).json({ error: 'User or restaurant data not found.' });
        } else {
            // Generic error handling
            res.status(500).json({ error: 'An error occurred while fetching restaurants.' });
        }
    }
});

// // Create a new user
// app.post('/users',authenticateUser, async (req, res) => {

//     try {
        
//         const {
//             name,
//             email,
//             phone,
//             points,
//             membershipLevel,
//             isMember,
//         } = req.body;

//         // Validate required fields
//         if (!name || !points || !membershipLevel) {
//             return res.status(400).json({ message: 'Missing required fields' });
//         }

//         // Generate current timestamp for registrationDate and lastVisit
//         const currentDate = Timestamp.Timestamp.fromDate(new Date());
//         const newUser = {
//             name,
//             email: email || '',
//             phone: phone || '',
//             points,
//             membershipLevel,
//             registrationDate: currentDate,
//             lastVisit: currentDate, // Set both registrationDate and lastVisit to current timestamp
//             barcode,
//             isMember
//         };

//         const docRef = await admin.firestore().collection('users').add(newUser);
//         const userId = docRef.id;

//         res.status(201).json({ userId, ...newUser });
//     } catch (error) {
//         console.error('Error creating user:', error);
//         res.status(500).send('Error creating user');
//     }
// });

// Get all users
app.get('/users', async (req, res) => {


    try {
        const snapshot = await admin.firestore().collection('users').get();
        const usersList = snapshot.docs.map(doc => ({
            userId: doc.id,
            ...doc.data()
        }));
        res.status(200).json(usersList);
    } catch (error) {
        console.error('Error getting users:', error);
        res.status(500).send('Error getting users');
    }
});

// Get a single user by ID
app.get('/users/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const userDoc = await admin.firestore().collection('users').doc(userId).get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: 'User not found' });
        }

        const userData = userDoc.data();
        res.status(200).json({ userId, ...userData });
    } catch (error) {
        console.error('Error getting user by ID:', error);
        res.status(500).send('Error getting user');
    }
});

// Update a user by ID
app.put('/users/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const {
            name,
            email,
            phone,
            points,
            membershipLevel
        } = req.body;

        // Validate required fields
        if (!name || !points || !membershipLevel) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        // Generate current timestamp for lastVisit
        const currentDate = admin.firestore.Timestamp.now();

        const updatedUser = {
            name,
            email: email || '',
            phone: phone || '',
            points,
            membershipLevel,
            lastVisit: currentDate // Update lastVisit to current timestamp
        };

        const userRef = admin.firestore().collection('users').doc(userId);
        await userRef.set(updatedUser, { merge: true });

        res.status(200).json({ userId, ...updatedUser });
    } catch (error) {
        console.error('Error updating user:', error);
        res.status(500).send('Error updating user');
    }
});

// Delete a user by ID
app.delete('/users/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        await admin.firestore().collection('users').doc(userId).delete();
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).send('Error deleting user');
    }
});

// Expose Express app as a single Cloud Function:
exports.api = functions.https.onRequest(app);
