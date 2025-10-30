
import React from 'react';
import { useDispatch } from 'react-redux';
import { addItem } from '../features/cart/cartSlice';

const Product = ({ product }) => {
  const dispatch = useDispatch();

  return (
    <div style={styles.card}>
      <h3>{product.title}</h3>
      <p>${product.price}</p>
      <button onClick={() => dispatch(addItem(product))}>Add to Cart</button>
    </div>
  );
};

const styles = {
  card: {
    border: '1px solid #ccc',
    borderRadius: '6px',
    padding: '16px',
    textAlign: 'center',
    margin: '8px',
    width: '180px',
  },
};

export default Product;
